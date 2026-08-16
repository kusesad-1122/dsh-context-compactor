/**
 * dsh-context-compactor
 *
 * 开箱即用的「上下文压缩 / 上下文总结」插件，默认策略：
 *   - 上下文用量达到模型窗口 80% → 自动触发压缩；
 *   - 总结最优先：先把较早历史用 LLM 做成【详细】checkpoint 总结，
 *     绝不靠粗暴截断代替总结；
 *   - 总结双份保存：会话日志里持久化 compaction/* 事件 + checkpoint 节点，
 *     同时写一份 Markdown 到 ~/.dsh/storages/dsh-context-compactor/summaries/；
 *   - context-overflow 时同样先总结压缩，再自动重试本轮请求。
 *
 * 挂载方式：监听 `agent/created` 并补扫已存活 agent，在 agent scope 内用独立
 * isolate 挂载 DetailedCompactionEngine + ToolResultPruner；引擎监听器用
 * prepend 注册，保证本引擎的详细总结优先于 preset 自带的默认总结。
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { ManualCompactionError, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  contentHasImage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-context-compactor'

/** 本模块挂载成功的引擎实例表：/compact 的兜底（引擎是 agent 无关的，可服务任意会话）。 */
const LIVE_ENGINES = []

const CONFIG_KEYS = new Set([
  'enabled',
  'auto',
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'pruneToolResults',
  'pruneThresholdChars',
  'pruneHeadChars',
  'pruneTailChars',
  'registerCommands',
  'saveSummaryFile',
])

const DEFAULTS = Object.freeze({
  enabled: true,
  auto: true,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 12288,
  compactionRetries: 1,
  maxOverflowRetries: 2,
  pruneToolResults: true,
  pruneThresholdChars: 8192,
  pruneHeadChars: 4096,
  pruneTailChars: 1024,
  registerCommands: true,
  saveSummaryFile: true,
})

/**
 * 全局总结指令（用户明确要求的保留/删除策略）：
 *  保留：核心任务与当前进度、关键决策及理由、待解决问题、重要文件或代码位置；
 *  删除：详细调试过程、已解决的错误、客套话与重复内容；
 *  必须覆盖全部较早历史（全局），并与旧 checkpoint 做全局合并。
 */
const DETAIL_SUMMARY_INSTRUCTION = [
  '你现在是「全局上下文总结压缩引擎」。请把上方【全部较早历史对话】浓缩成一份全局中文 checkpoint，让另一个模型可以直接接手后续工作。',
  '',
  '必须严格按下面的 Markdown 结构输出。只写这 4 个部分，每一节都不能省略；确实没有内容就写「（无）」。',
  '',
  '# 核心任务与当前进度',
  '- [用户最初目标与最新要求；当前进行到哪一步、正在做什么；尚未完成的部分要写清]',
  '',
  '# 关键决策及理由',
  '- [每个重要决策、方案取舍、以及当时选择它的理由；影响后续工作的约束与偏好也放这里]',
  '',
  '# 待解决问题',
  '- [尚未解决的问题、阻塞点、待验证项、还需要什么信息；逐条列出，不要遗漏]',
  '',
  '# 重要文件或代码位置',
  '- [精确路径 + 文件/函数/类位置 + 为什么重要；关键代码片段只在必要且简短时保留]',
  '',
  '以下内容必须删掉，不要写进总结：',
  '- 详细调试过程（只保留最终结论）；',
  '- 已经解决的错误（不要保留报错原文和排查过程；若“为什么这样修”本身是重要决策，则并入“关键决策及理由”）；',
  '- 客套话、寒暄与所有重复内容。',
  '',
  '全局合并规则：',
  '- 总结必须覆盖整个较早历史，而不是只总结最后几轮或某一段。',
  '- 如果上方已经存在 <compacted-summary> 块，它是旧 checkpoint：不要逐字复制；对整段历史做全局合并——仍然成立的事实保留，已解决/已过时的删除，相同内容只保留一份。',
  '- 措辞影响判断的用户原话可逐字引用；文件路径、命令、标识符、数值、函数签名在“重要文件或代码位置”一节中原样保留。',
  '- 不要提及本次总结请求或“上下文被压缩”这件事。',
  '- 只输出 checkpoint 正文：不要调用任何工具，不要做任何其他操作。',
].join('\n')

const SUMMARY_OPEN_TAG = '<compacted-summary>'

/** 提示词增强指令：把用户草稿重写为更清晰、更完整、更适合 LLM 的提示词。 */
const ENHANCE_PROMPT_INSTRUCTION = [
  'You are a prompt engineering expert. Rewrite and improve the user\'s draft into a clear, well-structured, effective prompt for an AI assistant.',
  'Rules:',
  '- Keep the user\'s original intent and all concrete details; do not invent requirements.',
  '- If the draft is already excellent, only lightly polish it.',
  '- Output ONLY the enhanced prompt text, with no explanations, no quotes, no preamble.',
  '- Use the same language as the user\'s draft.',
].join('\n')

/** 用 DSH 当前模型增强提示词（供命令与专用 HTTP 接口共用，不写会话日志）。 */
async function enhanceText(ctx, session, agentOptions, text, signal) {
  const routed = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined
  let target
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    target = { provider: routed.provider, model: routed.model }
  } else if (
    typeof agentOptions?.provider === 'string' && agentOptions.provider.length > 0
    && typeof agentOptions?.model === 'string' && agentOptions.model.length > 0
  ) {
    target = { provider: agentOptions.provider, model: agentOptions.model }
  }
  if (target === undefined) {
    throw new Error('无法确定当前模型，无法增强提示词。')
  }
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('LLM 服务不可用。')

  const assembler = new BlockAssembler()
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: ENHANCE_PROMPT_INSTRUCTION + '\n\nUser draft:\n' + text }],
      source: { kind: 'plugin', plugin: 'dsh-context-compactor' },
    }),
  ]
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: 4096,
    sessionId: session.id,
    purpose: 'prompt-enhance',
    ...signal === undefined ? {} : { signal },
  })) assembler.push(chunk)

  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
  if (finish.kind === 'max-tokens') throw new Error('增强结果超出长度限制，请缩短草稿后重试。')
  const output = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (output.length === 0) throw new Error('模型没有返回增强结果。')
  return output
}

/** 注册一个不写会话日志的专用接口：POST /dsh-context-compactor/enhance。 */
function registerEnhanceRoute(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') return
  try {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-context-compactor/enhance',
    handler: async (req, res) => {
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
      let raw = ''
      for await (const chunk of req) raw += chunk
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return json(400, { ok: false, error: 'invalid json' })
      }
      const { sessionId, text } = payload ?? {}
      if (typeof sessionId !== 'string' || sessionId.length === 0
        || typeof text !== 'string' || text.trim().length === 0) {
        return json(400, { ok: false, error: 'sessionId and non-empty text are required' })
      }
      const agents = ctx.get('agents')
      const agent = agents !== undefined && typeof agents.get === 'function'
        ? agents.get(sessionId)
        : undefined
      if (agent === undefined) return json(404, { ok: false, error: 'session not found' })
      try {
        const output = await enhanceText(ctx, agent.session, agent.options, text, undefined)
        return json(200, { ok: true, text: output })
      } catch (error) {
        return json(500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'dsh-context-compactor enhance route')
  } catch (error) {
    // 热激活/重复装载时路由可能已注册，幂等跳过。
    ctx.logger.info(
      'dsh-context-compactor: enhance route already registered or unavailable: '
      + (error instanceof Error ? error.message : String(error)),
    )
  }
}

function fail(message) {
  throw new Error(`dsh-context-compactor: ${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertBoolean(value, key) {
  if (typeof value !== 'boolean') fail(`config "${key}" must be a boolean`)
  return value
}

function assertRatio(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(`config "${key}" must be a number in (0, 1]`)
  }
  return value
}

function assertNonNegativeInteger(value, key) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`config "${key}" must be a non-negative integer`)
  }
  return value
}

function assertPositiveInteger(value, key) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`config "${key}" must be a positive integer`)
  }
  return value
}

function assertOptionalString(value, key) {
  if (value === undefined) return ''
  if (typeof value !== 'string') fail(`config "${key}" must be a string`)
  return value
}

function resolveModelPolicies(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail('config "modelPolicies" must be an array')
  return raw.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`config "modelPolicies[${index}]" must be an object`)
    if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
      fail(`config "modelPolicies[${index}].provider" must be a non-empty string`)
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      fail(`config "modelPolicies[${index}].model" must be a non-empty string`)
    }
    if (entry.contextWindow !== undefined) {
      assertPositiveInteger(entry.contextWindow, `modelPolicies[${index}].contextWindow`)
    }
    return { ...entry }
  })
}

/** 校验并补默认值；未识别键直接报错，避免拼写错误被静默吞掉。 */
function resolveConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (!isPlainObject(raw)) fail('config must be an object')
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) fail(`unknown config key "${key}"`)
  }

  const enabled = raw.enabled === undefined ? DEFAULTS.enabled : assertBoolean(raw.enabled, 'enabled')
  const auto = raw.auto === undefined ? DEFAULTS.auto : assertBoolean(raw.auto, 'auto')
  const thresholdRatio = raw.thresholdRatio === undefined
    ? DEFAULTS.thresholdRatio
    : assertRatio(raw.thresholdRatio, 'thresholdRatio')
  const retainRatio = raw.retainRatio === undefined
    ? DEFAULTS.retainRatio
    : assertRatio(raw.retainRatio, 'retainRatio')
  const retainTokens = raw.retainTokens === undefined
    ? undefined
    : assertNonNegativeInteger(raw.retainTokens, 'retainTokens')
  if (raw.retainRatio !== undefined && retainTokens !== undefined) {
    fail('config "retainRatio" and "retainTokens" are mutually exclusive')
  }
  if (retainRatio >= thresholdRatio) {
    fail(`config "retainRatio" (${retainRatio}) must be less than "thresholdRatio" (${thresholdRatio})`)
  }

  const summarizationProvider = assertOptionalString(raw.summarizationProvider, 'summarizationProvider')
  const summarizationModel = assertOptionalString(raw.summarizationModel, 'summarizationModel')
  if ((summarizationProvider.length === 0) !== (summarizationModel.length === 0)) {
    fail('config "summarizationProvider" and "summarizationModel" must be set together as an empty or non-empty pair')
  }

  return Object.freeze({
    enabled,
    auto,
    thresholdRatio,
    retainRatio,
    retainTokens,
    summarizationProvider,
    summarizationModel,
    maxTokens: raw.maxTokens === undefined
      ? DEFAULTS.maxTokens
      : assertPositiveInteger(raw.maxTokens, 'maxTokens'),
    compactionRetries: raw.compactionRetries === undefined
      ? DEFAULTS.compactionRetries
      : assertNonNegativeInteger(raw.compactionRetries, 'compactionRetries'),
    maxOverflowRetries: raw.maxOverflowRetries === undefined
      ? DEFAULTS.maxOverflowRetries
      : assertNonNegativeInteger(raw.maxOverflowRetries, 'maxOverflowRetries'),
    modelPolicies: Object.freeze(resolveModelPolicies(raw.modelPolicies)),
    pruneToolResults: raw.pruneToolResults === undefined
      ? DEFAULTS.pruneToolResults
      : assertBoolean(raw.pruneToolResults, 'pruneToolResults'),
    pruneThresholdChars: raw.pruneThresholdChars === undefined
      ? DEFAULTS.pruneThresholdChars
      : assertPositiveInteger(raw.pruneThresholdChars, 'pruneThresholdChars'),
    pruneHeadChars: raw.pruneHeadChars === undefined
      ? DEFAULTS.pruneHeadChars
      : assertNonNegativeInteger(raw.pruneHeadChars, 'pruneHeadChars'),
    pruneTailChars: raw.pruneTailChars === undefined
      ? DEFAULTS.pruneTailChars
      : assertNonNegativeInteger(raw.pruneTailChars, 'pruneTailChars'),
    registerCommands: raw.registerCommands === undefined
      ? DEFAULTS.registerCommands
      : assertBoolean(raw.registerCommands, 'registerCommands'),
    saveSummaryFile: raw.saveSummaryFile === undefined
      ? DEFAULTS.saveSummaryFile
      : assertBoolean(raw.saveSummaryFile, 'saveSummaryFile'),
  })
}

/** 交给上游引擎的那份配置。 */
function engineConfig(cfg) {
  return {
    auto: cfg.auto,
    thresholdRatio: cfg.thresholdRatio,
    ...cfg.retainTokens === undefined
      ? { retainRatio: cfg.retainRatio }
      : { retainTokens: cfg.retainTokens },
    summarizationProvider: cfg.summarizationProvider,
    summarizationModel: cfg.summarizationModel,
    maxTokens: cfg.maxTokens,
    compactionRetries: cfg.compactionRetries,
    maxOverflowRetries: cfg.maxOverflowRetries,
    modelPolicies: cfg.modelPolicies.map((entry) => ({ ...entry })),
    saveSummaryFile: cfg.saveSummaryFile,
  }
}

/** 单个路由目标命中的阈值（用于状态展示，与上游 merge 语义一致）。 */
function pickThresholdRatio(cfg, target) {
  if (target === undefined) return cfg.thresholdRatio
  const override = cfg.modelPolicies.find(
    (entry) => entry.provider === target.provider && entry.model === target.model,
  )
  return override?.thresholdRatio ?? cfg.thresholdRatio
}

function summaryFilePath(sessionId) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(home, 'storages', 'dsh-context-compactor', 'summaries', `${safe}.md`)
}

function routedTarget(session) {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/** 合并 modelPolicies 覆盖后的阈值、保留策略与真实上下文窗口。 */
function targetPolicy(config, target) {
  const override = config.modelPolicies.find(
    (entry) => entry.provider === target.provider && entry.model === target.model,
  )
  return {
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    retainRatio: override?.retainRatio ?? config.retainRatio,
    retainTokens: override?.retainTokens ?? config.retainTokens,
    contextWindow: override?.contextWindow,
  }
}

/** 头部里的 maxTokens 若非常大（>=100k），视为该 provider 的真实上下文上限兜底。 */
function headerWindowHint(session) {
  try {
    const config = session.requestHeader()?.config
    if (config !== undefined && typeof config.maxTokens === 'number' && config.maxTokens >= 100000) {
      return config.maxTokens
    }
  } catch {}
  return undefined
}

/**
 * 选择「全部较早历史」的压缩范围（head-anchored），保留最近 retainTokens 的
 * 原样尾巴；与上游 selectCompactableRange 语义一致，用于保证压缩后的减量。
 */
function selectGlobalRange(session, measurement, retainTokens) {
  const pricedNodes = measurement.nodes
  if (!Array.isArray(pricedNodes) || pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null

  while (keepFromIdx > 0) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null

  return { start: surfaceNodes[0], end: surfaceNodes[keepFromIdx - 1] }
}

/**
 * 详细总结版压缩引擎：
 * - 监听器用 prepend 注册 → 在任何 preset 默认引擎之前先执行，保证“总结优先”
 *   且用的是详细总结；
 * - summarize() 覆盖为详细中文 checkpoint 指令，并把总结落盘保存；
 * - 压力/overflow 触发逻辑（80% 阈值、保留尾巴、重试预算）继承官方实现。
 */
class DetailedCompactionEngine extends BasicCompactionEngine {
  // 挂载方式：compCtx.plugin(DetailedCompactionEngine, config)。
  // 这样会创建带 inject 的子 fiber（继承父类 static inject =
  // ['llm', 'tokenMeter', 'sessions']），引擎内部访问 this.ctx.tokenMeter /
  // this.ctx.llm 才有正确的服务解析路径。
  // Config 显式置空：跳过父类 schema 校验，把包含 saveSummaryFile 的完整
  // 配置原样交给构造函数（父类 resolveConfig 会自行校验上游字段）。
  static Config = undefined

  constructor(ctx, config = {}) {
    const { saveSummaryFile, modelPolicies = [], ...engineFields } = config ?? {}
    // 摘出 contextWindow 覆盖（modlens 等 provider 会上报错误的 1M 窗口，
    // 需要按真实窗口覆盖），并把不含该字段的 modelPolicies 交给父类。
    this._contextWindowOverrides = new Map()
    const sanitizedPolicies = (Array.isArray(modelPolicies) ? modelPolicies : []).map((entry) => {
      if (entry && typeof entry === 'object' && typeof entry.contextWindow === 'number') {
        this._contextWindowOverrides.set(`${entry.provider}/${entry.model}`, entry.contextWindow)
      }
      if (entry && typeof entry === 'object' && 'contextWindow' in entry) {
        const { contextWindow: _drop, ...rest } = entry
        return rest
      }
      return entry
    })
    // 关闭父类的自动监听，改由本类以 prepend 方式注册。
    super(ctx, { ...engineFields, modelPolicies: sanitizedPolicies, auto: false })
    this._saveSummaryFile = saveSummaryFile ?? true
    this._auto = engineFields.auto ?? true
    this._summaryCapOverride = null
    if (this._auto) this._registerPrependAuto()
  }

  _registerPrependAuto() {
    const { ctx } = this
    const logResult = (result, trigger) => {
      ctx.logger.info(
        `detailed compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }
    const overflowRetries = new WeakMap()
    const overflowAgents = new WeakMap()

    // prepend：先于其他压缩引擎执行 → 80% 时先用详细总结压缩。
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`detailed step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    }, { prepend: true })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') overflowRetries.delete(agent)
    }, { prepend: true })

    // 成功产出 assistant 回复即重置本回合的 overflow 恢复序列。
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = overflowAgents.get(session)
      if (agent !== undefined) overflowRetries.delete(agent)
    }, { prepend: true })

    // prepend：provider 明确报 context length 超限时，先详细总结压缩，再 retry。
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const retries = overflowRetries.get(agent) ?? 0
      if (retries >= this.config.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result = null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `detailed context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          `detailed context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    }, { prepend: true })
  }

  /**
   * 真正的压缩：不满足「压缩后 totalTokens 必须下降」就不算成功。
   *
   * 自动压力/overflow 路径：先裁剪工具结果，然后从配置保留尾巴开始，
   * 逐级「减保留尾巴 + 减总结预算」重复压缩全部较早历史，直到
   *   - pressure：压缩后 totalTokens < 阈值（默认 80%）；
   *   - context-overflow：压缩后 totalTokens < 压缩前。
   * 全部尝试后仍未下降 → 抛错（绝不以“没变化”冒充成功）。
   */
  async compactIfNeeded(agent, trigger, signal) {
    const meter = this.ctx.tokenMeter
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = targetPolicy(this.config, target)

    let thresholdTokens = 0
    let contextWindow
    if (trigger === 'pressure') {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      const adapterWindow = info.context?.contextWindow
      const override = this._contextWindowOverrides.get(`${target.provider}/${target.model}`)
      // 优先：显式覆盖 > header 里的超大 maxTokens（>=100k，视为真实窗口）
      // 最后才回退适配器上报的窗口（modlens 等会上报错误的 1M）。
      contextWindow = override ?? headerWindowHint(agent.session) ?? adapterWindow
      if (contextWindow === undefined) {
        throw new Error(
          `no context capacity for ${target.provider}/${target.model}; `
          + 'configure contextWindow in modelPolicies or on that adapter model',
        )
      }
      thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)
    }

    const before = meter.measure(agent.session)
    if (trigger === 'pressure' && before.totalTokens < thresholdTokens) return null
    const beforeTotal = before.totalTokens

    const prune = this.ctx.get('toolResultPruner')
    if (prune !== undefined) prune.pruneSession(agent.session)
    let measurement = meter.measure(agent.session)

    const baseRetain = policy.retainTokens !== undefined
      ? policy.retainTokens
      : Math.floor((contextWindow ?? beforeTotal) * policy.retainRatio)
    const retainLevels = trigger === 'context-overflow'
      ? [0]
      : [...new Set([
          baseRetain,
          Math.floor(baseRetain / 2),
          Math.floor(baseRetain / 4),
          0,
        ])].sort((a, b) => b - a)
    const capLevels = [...new Set([
      this.config.maxTokens,
      Math.floor(this.config.maxTokens / 2),
      Math.floor(this.config.maxTokens / 4),
      1024,
    ])]

    let lastResult = null
    for (const retain of retainLevels) {
      for (const cap of capLevels) {
        const range = selectGlobalRange(agent.session, measurement, retain)
        if (range === null) break
        this._summaryCapOverride = cap
        let result
        try {
          result = await this.compactRegion(range.start, range.end, agent, signal)
        } catch (error) {
          // 活跃会话在总结期间写入新节点会触发 surface changed；重新测量后重试一次。
          const message = error instanceof Error ? error.message : String(error)
          if (signal.aborted || !message.includes('surface changed')) throw error
          measurement = meter.measure(agent.session)
          continue
        }
        lastResult = result
        measurement = meter.measure(agent.session)

        if (prune !== undefined) prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)

        if (trigger === 'context-overflow') {
          if (measurement.totalTokens < beforeTotal) {
            this.ctx.logger.info(
              `detailed compaction verified: ${beforeTotal} -> ${measurement.totalTokens} tokens `
              + `(${Math.max(0, Math.round((1 - measurement.totalTokens / beforeTotal) * 100))}% reduced)`,
            )
            return result
          }
        } else if (measurement.totalTokens < thresholdTokens) {
          this.ctx.logger.info(
            `detailed compaction verified: ${beforeTotal} -> ${measurement.totalTokens} tokens `
            + `(threshold ${thresholdTokens}; ${Math.max(0, Math.round((1 - measurement.totalTokens / beforeTotal) * 100))}% reduced)`,
          )
          return result
        }
      }
    }

    const after = measurement.totalTokens
    // 若裁剪工具结果本身已把压力压回阈值内，也算成功（真实减量）。
    if (trigger === 'pressure' && after < thresholdTokens) {
      if (lastResult !== null) {
        this.ctx.logger.info(
          `detailed compaction verified: ${beforeTotal} -> ${after} tokens (threshold ${thresholdTokens}; pruned+compacted)`,
        )
        return lastResult
      }
      this.ctx.logger.info(
        `detailed compaction verified (prune-only): ${beforeTotal} -> ${after} tokens (threshold ${thresholdTokens})`,
      )
      return null
    }
    throw new Error(
      `compaction did NOT actually shrink context: before ${beforeTotal} tokens, after ${after} tokens `
      + (trigger === 'pressure' ? `(threshold ${thresholdTokens})` : ''),
    )
  }

  /**
   * 手动 /compact 同样必须真实减量：super.compactNow 已经压到 retain=0，
   * 这里做 before/after 校验；若总结反而变大，就降低总结预算重试，最多 4 次。
   */
  async compactNow(agent, signal, sourceCommandId) {
    const before = this.ctx.tokenMeter.measure(agent.session).totalTokens
    let cap = this.config.maxTokens
    let lastAfter = before
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this._summaryCapOverride = cap
      const result = await super.compactNow(
        agent,
        signal,
        attempt === 0 ? sourceCommandId : undefined,
      )
      if (result === null) return null
      const after = this.ctx.tokenMeter.measure(agent.session).totalTokens
      lastAfter = after
      if (after < before) {
        this.ctx.logger.info(
          `manual compaction verified: ${before} -> ${after} tokens `
          + `(${Math.max(0, Math.round((1 - after / before) * 100))}% reduced)`,
        )
        return result
      }
      cap = Math.max(1024, Math.floor(cap / 2))
    }
    throw new Error(
      `compaction did NOT actually shrink context: before ${before} tokens, after ${lastAfter} tokens`,
    )
  }

  /**
   * 详细总结覆盖点：缓存友好的 prefix-replay 调用 + 详细中文 checkpoint 指令，
   * 并把总结正文额外写入 Markdown 文件。
   */
  async summarize(input, agent, signal) {
    const config = this.config
    const latest = agent.session.requestHeader()?.config
    const configured = config.summarizationProvider.length === 0
      ? undefined
      : { provider: config.summarizationProvider, model: config.summarizationModel }
    const agentTarget = agent.options.provider !== undefined && agent.options.provider.length > 0
      && agent.options.model !== undefined && agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
    const target = configured ?? latest ?? agentTarget
    if (target === undefined) {
      throw new Error(
        'no provider/model available for summarization: set summarizationProvider/summarizationModel, route one request, or set AgentOptions',
      )
    }

    const assembler = new BlockAssembler()
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: DETAIL_SUMMARY_INSTRUCTION }],
        source: { kind: 'plugin', plugin: 'dsh-context-compactor' },
      }),
    ]
    const effectiveMaxTokens = this._summaryCapOverride ?? config.maxTokens
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      ...input.system === undefined ? {} : { system: input.system },
      ...input.tools === undefined ? {} : { tools: [...input.tools] },
      maxTokens: effectiveMaxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const error = new Error(finish.failure.message)
      error.code = finish.failure.code
      throw error
    }
    if (finish.kind === 'max-tokens') {
      const error = new Error('detailed summarization truncated at the token cap (incomplete checkpoint)')
      error.code = 'MAX_TOKENS'
      throw error
    }

    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    this._writeSummaryFile(agent, summary)
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: effectiveMaxTokens,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }

  _writeSummaryFile(agent, summary) {
    if (!this._saveSummaryFile) return
    try {
      const text = summary.map((block) => block.text).join('\n')
      const file = summaryFilePath(agent.session.id)
      mkdirSync(dirname(file), { recursive: true })
      const header = [
        '# 上下文总结 checkpoint（dsh-context-compactor）',
        '',
        `- 时间：${new Date().toISOString()}`,
        `- 会话：${agent.session.id}`,
        '',
        '该文件与会话日志中的 compaction/summary 事件及 checkpoint 节点内容一致；',
        '完整可回放记录仍保存在会话日志里。',
        '',
        '---',
        '',
      ].join('\n')
      writeFileSync(file, header + text + '\n', 'utf8')
      this.ctx.logger.info(`detailed compaction summary saved: ${file}`)
    } catch (error) {
      this.ctx.logger.warn(
        `failed to save detailed compaction summary file: `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}

/** 拒绝图像输出，只保留文本块；空总结直接失败（绝不拿空内容替换历史）。 */
function summaryText(blocks) {
  if (contentHasImage(blocks)) {
    const error = new Error('detailed compaction summary cannot contain image output')
    error.code = 'UNSUPPORTED_CONTENT'
    throw error
  }
  const text = blocks.filter((block) => block.type === 'text')
  if (!text.some((block) => block.text.trim().length > 0)) {
    throw new Error('detailed summarization produced no text summary content')
  }
  return text
}

function compactErrorText(error) {
  switch (error.code) {
    case 'busy': return '压缩暂时不可用：已有一个压缩在进行，或 agent 当前不空闲。稍后再试。'
    case 'cancelled': return '压缩已取消。'
    case 'changed': return '待压缩的历史在提交前发生了变化；对话未改动，本次尝试已记录在会话日志中，可重试。'
    case 'summary': return '没能生成有效总结；对话未改动，本次尝试已记录在会话日志中。'
    case 'commit': return '压缩提交未完整完成，部分历史可能已变化；请检查当前会话状态后再重试。'
    case 'persistence': return '压缩完成，但会话保存失败。'
    default: return `压缩失败：${error.message}`
  }
}

function registerCommands(ctx, cfg, mounted) {
  const active = new Set()

  const track = (handler) => (invocation) => {
    const operation = Promise.resolve().then(() => handler(invocation))
    active.add(operation)
    const retire = () => { active.delete(operation) }
    operation.then(retire, retire)
    return operation
  }

  // 进程内重复热激活时，同一命令可能已注册；幂等跳过。
  const safeRegister = (definition) => {
    try {
      return ctx.commands.register(definition)
    } catch (error) {
      if (String(error).includes('already registered')) {
        ctx.logger.info(`dsh-context-compactor: command "/${definition.name}" already registered, skipping`)
        return () => {}
      }
      throw error
    }
  }

  const compactHandler = async (invocation) => {
    if (invocation.rawInput.trim().length > 0) {
      return { kind: 'error', text: '用法：/compact（不带参数）' }
    }
    // 优先本插件挂到这个 agent 上的详细引擎；其次任意已挂载引擎；
    // 再其次 agent scope / 宿主层可见的压缩服务。
    const engine = mounted.get(invocation.agent)?.engine
      ?? LIVE_ENGINES[0]
      ?? invocation.agent?.ctx?.get?.('compaction')
      ?? ctx.get('compaction')
    if (engine === undefined) {
      return { kind: 'error', text: '当前会话没有可用的压缩引擎。' }
    }
    try {
      const result = await engine.compactNow(
        invocation.agent,
        invocation.signal,
        invocation.commandId,
      )
      if (result === null) return { kind: 'success', text: '当前没有可压缩的历史。' }
      return {
        kind: 'success',
        text: `已【全局详细总结】并压缩 ${result.shadowedSeqs.length} 条历史（约 ${result.shadowedTokenCount} tokens）：`
          + '全部较早消息已被一个全局 checkpoint 节点替换，最近的对话尾巴保持不变。',
        sourceEventSeq: result.summarySeq,
      }
    } catch (error) {
      if (invocation.signal.aborted) return { kind: 'error', text: '压缩已取消。' }
      if (error instanceof ManualCompactionError) {
        return { kind: 'error', text: compactErrorText(error) }
      }
      throw error
    }
  }

  /** 提示词增强：把输入框草稿用 DSH 当前模型改写为更有效的提示词。 */
  const enhancePromptHandler = async (invocation) => {
    const trimmed = invocation.rawInput.trim()
    if (trimmed.length === 0) {
      return { kind: 'error', text: '用法：/enhance-prompt <草稿文本或 JSON {"text":"..."}>' }
    }
    let text = trimmed
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
        text = parsed.text
      }
    } catch {}
    if (text.trim().length === 0) {
      return { kind: 'error', text: '请输入要增强的提示词。' }
    }

    try {
      const output = await enhanceText(ctx, invocation.agent.session, invocation.agent.options, text, invocation.signal)
      return { kind: 'success', text: output }
    } catch (error) {
      if (invocation.signal.aborted) return { kind: 'error', text: '增强已取消。' }
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  const statusHandler = async (invocation) => {
    const { agent, signal } = invocation
    const session = agent.session
    const routed = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined
    let target
    if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
      target = { provider: routed.provider, model: routed.model }
    } else if (
      typeof agent.options?.provider === 'string' && agent.options.provider.length > 0
      && typeof agent.options?.model === 'string' && agent.options.model.length > 0
    ) {
      target = { provider: agent.options.provider, model: agent.options.model }
    }

    const lines = []
    if (target === undefined) {
      lines.push('当前会话还没有可识别的路由模型。')
    } else {
      lines.push(`路由模型：${target.provider}/${target.model}`)
    }

    const meter = ctx.get('tokenMeter')
    if (meter === undefined) {
      return { kind: 'error', text: 'token 计量服务不可用。' }
    }
    const measurement = meter.measure(session)
    lines.push(`上下文估算：~${measurement.totalTokens} tokens（历史表面 ~${measurement.surfaceTokens} tokens）`)

    let contextWindow
    const llm = ctx.get('llm')
    if (target !== undefined && llm !== undefined) {
      try {
        const info = await llm.resolveModelInfo(target.provider, target.model, signal)
        const override = cfg.modelPolicies.find(
          (entry) => entry.provider === target.provider && entry.model === target.model,
        )?.contextWindow
        contextWindow = override ?? headerWindowHint(session) ?? info.context?.contextWindow
      } catch (error) {
        lines.push(`模型信息读取失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (contextWindow !== undefined) {
      const ratio = pickThresholdRatio(cfg, target)
      const thresholdTokens = Math.floor(contextWindow * ratio)
      const percent = Math.round((measurement.totalTokens / contextWindow) * 100)
      lines.push(`模型窗口：${contextWindow} tokens；自动压缩阈值：${thresholdTokens} tokens（${Math.round(ratio * 100)}%）`)
      lines.push(`当前用量：${percent}%`)
      if (measurement.totalTokens >= thresholdTokens) {
        lines.push('⚠️ 已达到 80% 压缩阈值：下一次 step 前会先对【全部较早历史】做全局详细总结，再压缩替换。')
      } else {
        lines.push(`距压缩阈值还有约 ${thresholdTokens - measurement.totalTokens} tokens。`)
      }
      if (measurement.totalTokens >= contextWindow) {
        lines.push('⚠️ 已超过模型窗口：若模型报 context length 错误，会先做全局详细总结压缩，再自动重试本轮请求。')
      }
    } else {
      lines.push('当前 provider 未报告上下文窗口大小，压力阈值不可计算；context-overflow 自动恢复仍然生效。')
    }
    lines.push('压缩保证：每次压缩后都会校验 token 必须实际下降；未下降会自动降低保留尾巴/总结预算继续压缩。')
    if (cfg.saveSummaryFile) {
      lines.push(`总结保存：${summaryFilePath(agent.session.id)}`)
    }
    lines.push('手动压缩请输入：/compact')
    return { kind: 'success', text: lines.join('\n') }
  }

  // 生成器 effect：先排空在途命令，再注册；随 owning fiber 卸载自动清理。
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield safeRegister({
      name: 'compact',
      description: '全局总结并压缩较早的对话历史',
      handler: track(compactHandler),
    })
    yield safeRegister({
      name: 'enhance-prompt',
      description: '用当前模型增强输入框提示词',
      handler: track(enhancePromptHandler),
    })
    yield safeRegister({
      name: 'context-status',
      description: '查看上下文 token 用量、压缩阈值与风险提示',
      handler: track(statusHandler),
    })
  }, 'dsh-context-compactor commands')
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) {
    ctx.logger.info('dsh-context-compactor: disabled by config')
    return
  }

  /** agent -> { engine, pruner }（engine 供 /compact 直接引用）。 */
  const mounted = new WeakMap()

  const mountForAgent = (agent) => {
    if (!cfg.auto) return
    const agentCtx = agent?.ctx
    if (agentCtx === undefined || mounted.has(agent)) return
    if (typeof agentCtx.get !== 'function' || typeof agentCtx.isolate !== 'function') {
      ctx.logger.warn(`dsh-context-compactor: agent "${agent?.id}" has no mountable context`)
      return
    }

    const record = { engine: undefined, pruner: undefined }
    mounted.set(agent, record)
    try {
      // 每个 agent 一个独立 isolate：官方 preset 里 `isolate: { compaction: true,
      // toolResultPruner: true }` 的运行时等价物，互不抢占全局槽位。
      // 即使 preset 在隔离 realm 里挂了默认引擎，本引擎 prepend 监听器也会
      // 在自动压缩中先执行，保证「详细总结优先」。
      // 每个 agent 一个独立 isolate（不能共享标签，否则第二个 agent 的
      // provide('compaction') 会撞槽位报“已注册”，只剩第一个 agent 有引擎）。
      const compCtx = agentCtx
        .isolate('compaction')
        .isolate('toolResultPruner')

      // 关键：必须走 compCtx.plugin(Class, config) 挂载，而不是直接 new。
      // plugin() 会给每个引擎/裁剪器创建带 static inject 的子 fiber
      // （llm / tokenMeter / sessions），否则引擎内部访问
      // this.ctx.tokenMeter 会抛 "without inject"。
      const prunerLoaded = cfg.pruneToolResults
        ? Promise.resolve(compCtx.plugin(ToolResultPruner, {
            thresholdChars: cfg.pruneThresholdChars,
            headChars: cfg.pruneHeadChars,
            tailChars: cfg.pruneTailChars,
          })).then(() => {
            record.pruner = compCtx.get('toolResultPruner')
          }).catch((error) => {
            ctx.logger.warn(
              `dsh-context-compactor: failed to mount tool-result pruner for agent "${agent.id}": `
              + (error instanceof Error ? error.message : String(error)),
            )
          })
        : Promise.resolve()

      void prunerLoaded.then(() => {
        const engineFiber = compCtx.plugin(DetailedCompactionEngine, engineConfig(cfg))
        return Promise.resolve(engineFiber).then(() => {
          record.engine = compCtx.get('compaction')
          if (record.engine !== undefined && !LIVE_ENGINES.includes(record.engine)) {
            LIVE_ENGINES.push(record.engine)
          }
          ctx.logger.info(
            `dsh-context-compactor: mounted detailed compaction for agent "${agent.id}" `
            + `(threshold ${cfg.thresholdRatio}, overflow retries ${cfg.maxOverflowRetries})`,
          )
        })
      }).catch((error) => {
        ctx.logger.warn(
          `dsh-context-compactor: failed to mount compaction for agent "${agent?.id}": `
          + (error instanceof Error ? error.message : String(error)),
        )
      })
    } catch (error) {
      ctx.logger.warn(
        `dsh-context-compactor: failed to mount compaction for agent "${agent?.id}": `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  if (cfg.auto) {
    // 未来创建的 agent
    ctx.on('agent/created', ({ agent }) => { mountForAgent(agent) })
    // 插件加载时已经活着的 agent（热激活立刻生效）
    const agents = ctx.get('agents')
    if (agents?.store instanceof Map) {
      for (const entry of agents.store.values()) {
        if (entry?.agent !== undefined) mountForAgent(entry.agent)
      }
    }
  }

  if (cfg.registerCommands) {
    // commands 服务可用时立即注册；还没起来就等它注入。
    ctx.inject(['commands'], (cmdCtx) => {
      registerCommands(cmdCtx, cfg, mounted)
    })
  }

  // 专用 HTTP 接口：提示增强结果只回给前端，不写入会话日志/对话。
  registerEnhanceRoute(ctx)

  ctx.logger.info(
    'dsh-context-compactor: enabled '
    + `(auto=${cfg.auto}, thresholdRatio=${cfg.thresholdRatio}, maxTokens=${cfg.maxTokens}, `
    + `saveSummaryFile=${cfg.saveSummaryFile}, pruneToolResults=${cfg.pruneToolResults})`,
  )
}
