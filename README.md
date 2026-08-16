# dsh-context-compactor

开箱即用的 **上下文压缩 / 上下文总结** 插件。它把 DSH 官方 `dsh-compaction-basic`
压缩引擎 + 工具结果裁剪器一次性装配进 profile，解决「对话满了不会自动压缩、模型
直接报 `maximum context length` 导致本轮失败」的问题。

## 功能

### 1. 80% 自动触发（总结最优先 + 压缩后验）

- 通过 `ctx.tokenMeter` 估算当前会话 token 用量；
- 达到模型窗口 **80%**（`thresholdRatio` 默认 0.8）时，下一步前**自动先做详细总结**：
  把全部较早历史用 LLM 压缩成一份详尽中文 checkpoint，替换旧消息，只保留最近
  `retainRatio`（默认 16%）的原样尾巴；
- 本引擎的监听器以 **prepend** 注册，会抢在任何 preset 默认压缩引擎之前执行，
  保证“总结最优先”且用的是详细版总结；
- 压缩前后都有会话日志事件（`compaction/start`、`compaction/summary`、`compaction/end`）。

### 1.5 硬性保证：压缩必须真的变小

- **每次压缩都会做 before/after 校验**：压缩后 `totalTokens` 必须**严格小于**压缩前；
- 自动压缩：
  - 目标 = 低于 80% 阈值（所以 80% → 必须 < 80%，不是“压完还是 80%”）；
  - overflow 恢复：目标 = 低于压缩前；
  - 若第一次没达标，会自动**逐级降保留尾巴**（16% → 8% → 4% → 0%）并
    **逐级降总结预算**（12288 → 6144 → 3072 → 1024）反复压缩全部较早历史；
- 手动 `/compact`（包括按钮）：同样做 before/after 校验；若总结反而变大，
  自动降低总结预算重试，最多 4 次；仍不能下降就明确报错，绝不“假压缩”；
- 日志会打印 `before → after tokens（xx% reduced）`，方便确认真的压缩了。

### 1.6 真实上下文窗口（modlens / 第三方 provider 适配）

- 部分 provider（如 `modlens-qwen`）会向 DSH 上报一个很大的 `contextWindow`
  （例如 1,000,000），但真实可用窗口只有 256k。这会导致阈值算错、永远“不到 80%”。
- 插件现在的窗口解析顺序：
  1. `modelPolicies[].contextWindow`（显式覆盖，最优先）；
  2. 会话请求头里 ≥100k 的 `maxTokens`（视为真实窗口兜底，如 256000）；
  3. 适配器上报的 `contextWindow`（最后回退）。
- 需要手动指定时，在 profile 的插件 config 里加：

```yaml
modelPolicies:
  - provider: modlens-qwen
    model: DeepSeek-V4-Flash-0731
    contextWindow: 262144   # 按真实窗口填
    thresholdRatio: 0.8
```

### 2. 全局详细总结 + 双份保存

- **全局，不是只压一段**：每次触发都把“全部较早历史”（从最早消息到保留尾巴之前）
  一次性做成一个全局 checkpoint；若历史里已有旧 checkpoint，会与本次新消息
  **全局合并**——仍然成立的事实保留，已解决/过时的删除，相同内容只保留一份。
- 总结严格按保留/删除策略执行：
  - **必须保留**：① 核心任务与当前进度 ② 关键决策及理由 ③ 待解决问题
    ④ 重要文件或代码位置（精确路径/函数/类位置，必要时保留简短关键片段）；
  - **必须删除**：详细调试过程（只留结论）、已解决的错误（不保留报错原文与排查过程）、
    客套话与所有重复内容。
- **保存 1**：会话日志持久化 checkpoint 节点（可回放）；
- **保存 2**：额外写 Markdown 到
  `~/.dsh/storages/dsh-context-compactor/summaries/<session-id>.md`（默认开启，
  可关 `saveSummaryFile: false`）；
- 总结调用生成上限默认 `maxTokens: 12288`（详细预算，可调大）。

### 3. context-overflow 自动恢复（专治 context length 报错）

- provider 明确报上下文超限时，先详细总结压缩，再自动 **retry 本轮请求**；
- 默认最多连续恢复 `maxOverflowRetries` 次。

### 4. 超大工具结果裁剪（辅助手段，不替代总结）

- 超过 `pruneThresholdChars`（默认 8192 字符）的工具输出，保留头 + 标记 + 尾；
- 只裁剪工具结果文本，**对话历史一律走详细总结**，绝不粗暴截断。

### 5. 输入框上方的「压缩总结」+「提示增强」按钮

- 浏览器半边通过 `dsh.client` 清单自动发现，注册到 `conversation.input.dock`
  （输入框正上方，与 goal/todo 工具条同一排）；
- 工具条实时显示**上下文用量百分比**（`contextPressure` 投影），到 80% 自动
  高亮提醒；
- 左侧按钮「压缩总结」：点击通过 `remote.commands.execute(sessionId, '/compact')`
  立即触发全局详细总结压缩，按钮会显示「压缩总结中…」并在条上回显结果；
- 右侧按钮「提示增强」：这是合并自 [LLM-Prompt-Enhancer](https://github.com/RunOnCodes/LLM-Prompt-Enhancer)
  的功能，点击读取输入框草稿，调用 DSH 当前模型增强为更清晰的提示词，
  自动写回输入框（无需额外 Groq Key）；按钮显示「增强中…」并在条上回显结果；
- agent 运行中按钮自动禁用；全新空白会话不显示。

### 6. 手动命令

| 命令 | 作用 |
| --- | --- |
| `/compact` | 立即【全局详细总结】并把全部较早历史压缩成一个 checkpoint |
| `/enhance-prompt` | 用当前模型增强提示词（支持直接跟文本或 JSON `{"text":"..."}`） |
| `/context-status` | 查看 token 用量、窗口、80% 阈值、风险与总结保存路径 |

## 默认配置

```yaml
enabled: true
auto: true                      # 开启 80% 压力压缩 + overflow 自动恢复
thresholdRatio: 0.8             # 用量达到窗口 80% 触发【详细总结】压缩
retainRatio: 0.16               # 保留最近 16% 的原样对话
maxTokens: 12288                # 总结调用生成上限（详细预算）
compactionRetries: 1            # 一次压力压缩后仍超阈值时的追加尝试
maxOverflowRetries: 2           # context-overflow 恢复重试上限
saveSummaryFile: true           # 总结额外落盘到 ~/.dsh/storages/dsh-context-compactor/summaries/
pruneToolResults: true          # 只裁剪超大工具结果；对话历史一律走总结
pruneThresholdChars: 8192
pruneHeadChars: 4096
pruneTailChars: 1024
registerCommands: true
```

也可以给指定模型写精确覆盖策略：

```yaml
modelPolicies:
  - provider: deepseek
    model: deepseek-chat
    thresholdRatio: 0.7
    retainRatio: 0.2
    maxOverflowRetries: 3
```

## 工作原理（与官方架构一致）

DSH 的 `dsh-web-app` 会禁用宿主层的压缩后端，压缩由每个 **agent preset** 决定。
本插件不跟宿主层抢位置：它监听 `agent/created`（并补扫已存活 agent），对没有压缩
引擎的 agent 在其 **agent scope 内用独立 `isolate`** 挂载 `compaction-basic` 和
`tool-result-pruner`——等价于官方 `standard` preset 里的

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

因此：

- 每个 agent 一个独立槽位，不会抢占全局服务名；
- 即使 preset 自带默认引擎，本引擎的 prepend 监听器也会在自动压缩中**先执行**，
  保证“详细总结优先”；
- 引擎生命周期跟随 agent，agent 销毁即回收。

## 安装

```bash
# 1. 构建（host: src → lib/index.js；client: src/client → lib/client.js）
bash scripts/build.sh

# 2. 加入 profile（写入 dependencies + bundles，重启后自动装配）
#    profile 包名：@dsh-external/dsh-context-compactor
#    根入口 index.js 同时兼容「按包根 index.js 导入」的 loader 约定。
#    浏览器按钮无需额外配置：clientModules 会通过 dsh.client 清单 +
#    exports["./client"] 自动发现并伺服 lib/client.js。

# 3. 热装配（当前进程立即生效）
#    dev_install_package / dev_inject_plugin 指向本目录
#    若遇到 loader 模块缓存中毒，重启 DSH 即可（bundle 路径不依赖热装配）。
```

装配后刷新页面，输入框上方会出现「压缩总结」工具条；输入
`/context-status` 可查看用量与阈值。

## 说明

- 总结调用会优先复用当前会话实际路由的 provider/model；也可用
  `summarizationProvider` + `summarizationModel` 指定专门的总结模型。
- 单条消息本身就超过模型窗口时，任何表面压缩都无法修复——这种情况需要
  换更大窗口的模型或拆小输入。
