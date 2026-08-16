/**
 * dsh-context-compactor 浏览器半边（client bundle 源码，CJS 形态）。
 * 构建时被 scripts/build-client.mjs 包进 __ModuleLoader__.load 工厂。
 *
 * 在输入框上方（conversation.input.dock）渲染一条「压缩总结」工具条：
 *   - 实时显示上下文用量百分比（contextPressure 投影）；
 *   - 达到 80% 时百分比高亮；
 *   - 点击按钮通过 remote.commands.execute(sessionId, '/compact') 立即触发
 *     详细总结压缩；agent 运行中自动禁用。
 */

const React = require('react')
const { IconEnhanceOutline16, IconSparkle16, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

const name = 'dsh-context-compactor'
const inject = ['slots', 'remote', 'remote.commands']

const STYLES = `
[data-dsh-context-compactor-dock] {
  box-sizing: border-box;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 2 * var(--dsh-composer-dock-inset));
  margin: 0 auto;
}
[data-dsh-context-compactor-dock] .cc-bar {
  box-sizing: border-box;
  width: 100%;
  max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-tip);
  border-radius: 12px;
  align-items: center;
  gap: 10px;
  height: 36px;
  margin: 0 auto;
  padding: 4px 5px 4px 12px;
  display: flex;
}
[data-dsh-context-compactor-dock] .cc-meter {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  font-size: 12px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}
[data-dsh-context-compactor-dock] .cc-meter.cc-warn {
  color: var(--dsw-alias-state-warning, #d97706);
  font-weight: 600;
}
[data-dsh-context-compactor-dock] .cc-feedback {
  min-width: 0;
  flex: 1;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12px;
  line-height: 20px;
}
[data-dsh-context-compactor-dock] .cc-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  line-height: 20px;
}
[data-dsh-context-compactor-dock] .cc-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-context-compactor-dock] .cc-button:disabled {
  opacity: 0.4;
  cursor: default;
}
`

function installStyles() {
  if (typeof document === 'undefined') return
  const tagId = '@dsh-external/dsh-context-compactor/dock.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-external/dsh-context-compactor'
  tag.dataset.pluginCss = tagId
  tag.textContent = STYLES
  document.head.appendChild(tag)
}

/** 输入框上方的 dock 条目：用量 + 压缩总结按钮 + 执行反馈。 */
function CompactDock(props) {
  const { session, useProjection } = props
  const pressure = typeof useProjection === 'function' ? useProjection('contextPressure') : undefined
  const [pending, setPending] = React.useState(false)
  const [enhancing, setEnhancing] = React.useState(false)
  const [feedback, setFeedback] = React.useState(null)
  const pendingRef = React.useRef(false)
  const enhancingRef = React.useRef(false)
  const timerRef = React.useRef(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  const run = React.useCallback(async () => {
    if (pendingRef.current || session.running) return
    pendingRef.current = true
    setPending(true)
    setFeedback(null)
    try {
      const text = await props.compact()
      setFeedback(text)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { setFeedback(null) }, 8000)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [props.compact, session.running])

  const runEnhance = React.useCallback(async () => {
    const draft = props.input && typeof props.input.draft === 'string' ? props.input.draft : ''
    if (!draft.trim()) {
      setFeedback('输入为空：先写点内容再增强')
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { setFeedback(null) }, 5000)
      return
    }
    if (enhancingRef.current) return
    enhancingRef.current = true
    setEnhancing(true)
    setFeedback(null)
    try {
      const res = await props.enhance(draft)
      let msg
      if (res && res.ok) {
        if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
          props.inputActions.setDraft(res.text)
          msg = '已增强并写入输入框'
        } else {
          msg = res.text
        }
      } else {
        msg = (res && res.error) || '增强失败'
      }
      setFeedback(msg)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { setFeedback(null) }, 10000)
    } finally {
      enhancingRef.current = false
      setEnhancing(false)
    }
  }, [props.enhance, props.input, props.inputActions])

  // 全新空白会话不显示工具条。
  if (session.blank) return null

  const windowTokens = pressure && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : undefined
  const usedTokens = pressure
    ? (typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens
      : typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : 0)
    : 0
  const percent = windowTokens !== undefined && windowTokens > 0
    ? Math.min(999, Math.round((usedTokens / windowTokens) * 100))
    : null
  const warn = percent !== null && percent >= 80
  const meterText = percent === null ? '上下文用量未知' : '上下文 ' + percent + '%'

  return React.createElement(
    'div',
    { className: 'cc-dock', 'data-dsh-context-compactor-dock': '' },
    React.createElement(
      'div',
      { className: 'cc-bar' },
      React.createElement('span', { className: 'cc-meter' + (warn ? ' cc-warn' : '') }, meterText),
      feedback !== null
        ? React.createElement('span', { className: 'cc-feedback', title: feedback }, feedback)
        : null,
      React.createElement(
        Tooltip,
        {
          label: '对全部较早历史做全局详细总结并压缩（达到 80% 自动触发）',
          side: 'top',
          delayMs: 500,
        },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'cc-button',
            disabled: pending || session.running,
            onClick: () => { void run() },
            'aria-label': '压缩总结上下文',
            title: session.running ? 'agent 运行中，稍后再试' : undefined,
          },
          pending
            ? React.createElement('span', null, '压缩总结中…')
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(IconSparkle16, { size: 14 }),
                React.createElement('span', null, '压缩总结'),
              ),
        ),
      ),
      React.createElement(
        Tooltip,
        {
          label: '用当前模型增强输入框提示词（Prompt Enhancer 合并功能）',
          side: 'top',
          delayMs: 500,
        },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'cc-button',
            disabled: enhancing || session.running,
            onClick: () => { void runEnhance() },
            'aria-label': '增强提示词',
            title: session.running ? 'agent 运行中，稍后再试' : undefined,
          },
          enhancing
            ? React.createElement('span', null, '增强中…')
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(IconEnhanceOutline16, { size: 14 }),
                React.createElement('span', null, '提示增强'),
              ),
        ),
      ),
    ),
  )
}

function apply(ctx) {
  installStyles()
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'context-compact',
    order: 5,
    inject: (sessionId) => ({
      /** 执行 /compact，返回用户可见的结果文案（不抛错）。 */
      compact: async () => {
        try {
          const result = await ctx.remote.commands.execute(sessionId, '/compact')
          if (!result.ok) return result.error.message + ' (' + result.error.code + ')'
          if (result.value === undefined) return '未知命令：/compact'
          return result.value.text
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      /** 用 DSH 当前模型增强提示词；返回 {ok,text|error}。 */
      enhance: async (text) => {
        try {
          const result = await ctx.remote.commands.execute(
            sessionId,
            '/enhance-prompt ' + JSON.stringify({ text }),
          )
          if (!result.ok) {
            return { ok: false, error: result.error.message + ' (' + result.error.code + ')' }
          }
          const value = result.value
          if (!value || value.kind === 'error') {
            return { ok: false, error: value ? value.text : '增强失败' }
          }
          return { ok: true, text: value.text }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  }, CompactDock))
}

module.exports = { name, inject, apply }
