# Contract: 插件入口

**Feature**: `001-target-monitor` | **Type**: cordis 插件（ESM）

## 导出

```ts
export const name = 'target-monitor'
export const inject = ['agents', 'tools', 'systemPrompt']
export const Config = z.object({ ... })
export function apply(ctx: Context, config: Config): void
```

与宿主约定一致（对照 `dsh-persona`、`dsh-tool-goal` 的产物形态）。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；关闭时不注册工具与章节，行为完全等价于未安装 |
| `stallNoticeThreshold` | number | `5` | 第几次未声明时向用户发出"可能卡住"提示；必须是正安全整数 |

**校验**：非法值在 `apply` 中同步抛出（fail loud），不得静默回退到默认值。

## 注册项与失败策略

| 注册项 | 依赖 | 失败行为 |
|---|---|---|
| 系统提示词章节 `tool:target-monitor` | `ctx.systemPrompt` | 缺失 → 抛出明确错误并停用（FR-015） |
| 工具 `target_status` | `ctx.tools` | 同上 |
| `agent/turn-stopping` 监听 | cordis events | 若事件不可用 → 同上 |
| `agent/assistant-stream` 监听（取 finish） | cordis events | 缺失时降级为"全部按 undeclared 处理"并记录一次警告 |

## 事件订阅

| 事件 | 用途 | 模式 |
|---|---|---|
| `agent/turn-stopping` | 收尾判定与投递 | serial（宿主保证 awaited） |
| `agent/assistant-stream` | 记录最后一次 `finish.reason.kind` | emit |
| `agent/disposed` | 清理该 agent 的闩锁 | emit |

## 顺序与副作用

- 系统提示词章节只注册一次，`order` 取 `ctx.systemPrompt.getSectionOrder(...)` 的既有槽位之后，避免与 `tool:goal` 策略段冲突。
- **注入必须排在队首**：宿主的收尾判断仅在 `nextStep` 为空时派发，故正常路径下 `steer` 追加即位于队首；若进入时 `agent.inbox.nextStep` 非空（竞态），改用 `agent.inbox.prepend('next-step', message)`。未完成的任务不得先接到排队的新指令（FR-017）。
- 监听器内的任何异常必须就地捕获并记录，**不得**向宿主抛出——否则会打断整轮对话（宪法 III）。
- 插件不得修改 agent 的模型、provider、权限或沙箱配置。

## 兼容性

- 宿主版本：`0.2.1-rc.5`（`peerDependencies` 对齐）
- 若宿主的 `agent/turn-stopping` 语义变更（例如不再允许 steer），插件必须在启动自检中失败并明确告知，而不是静默失效
