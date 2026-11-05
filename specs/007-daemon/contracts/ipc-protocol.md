# 契约：守护进程 IPC 协议（v1）

传输：unix domain socket，UTF-8，**一行一条 JSON**（NDJSON）。单行上限 64 KiB，超限即断开。

## 握手

客户端在连接后**必须**立即发送 `hello`，在此之前发送任何其他消息都按协议错误处理。

```jsonc
// C → S
{ "type": "hello", "protocol": 1, "clientId": "48213-a1b2c3", "pid": 48213 }
// S → C（接受）
{ "type": "welcome", "protocol": 1, "serverPid": 51002 }
// S → C（拒绝）
{ "type": "fatal", "reason": "protocol", "expected": 1, "received": 2 }
```

- **C-001**：`protocol` 不等于守护进程支持值时，守护进程 MUST 回 `fatal` 并断开；客户端 MUST 转为降级模式，不再重试。
- **C-002**：`clientId` 由客户端生成，形如 `<pid>-<6 位十六进制>`，在同一守护进程生命周期内唯一。

## 请求

所有请求共享三个字段：`requestId`（`<clientId>:<序号>`）、`sessionId`、`turn`。

| `type` | 额外字段 | 语义 |
|---|---|---|
| `turn-start` | `config` | 轮次开始，重置本轮的声明状态 |
| `declare` | `state`（`done` \| `awaiting_user`）、`config` | 模型声明目标状态 |
| `turn-stopping` | `finishKind`、`aborted`、`isRoot`、`config` | 收尾判定 |
| `upstream-error` | `errorCode`、`config` | 上游失败，决定是否排队续行 |
| `resume-confirm` | `errorCode`、`config` | idle 之后的二次判定 |
| `finish` | `kind`（`stop` \| `tool-calls` \| `max-tokens` \| `aborted` \| `error`） | 正常结束，清零续行计数 |
| `dispose` | 无 | 会话结束，回收该会话状态 |

```jsonc
// 例：收尾判定
{ "type": "turn-stopping", "requestId": "48213-a1b2c3:17",
  "sessionId": "sess_9f2", "turn": 12, "finishKind": "stop",
  "aborted": false, "isRoot": true,
  "config": { "enabled": true, "stallNoticeThreshold": 5, "reminderThreshold": 3,
              "reactionWindowMs": 30000, "resumeOnUpstreamError": true,
              "maxResumes": 3, "declarationSection": true } }
```

## 响应

```jsonc
// 成功
{ "type": "ok", "requestId": "48213-a1b2c3:17", "data": { … } }
// 失败
{ "type": "error", "requestId": "48213-a1b2c3:17", "code": "E_BAD_REQUEST", "message": "turn must be a non-negative integer" }
```

`data` 按请求类型定义：

| 请求 | `data` 形状 |
|---|---|
| `turn-start` | `{}` |
| `declare` | `{ "forgetCount": 2, "counted": true }` —— `counted` 表示本次是否计入遗忘次数（窗口内） |
| `turn-stopping` | `{ "inject": true, "attempt": 2, "reminder": false, "trace": { … } }` |
| `upstream-error` | `{ "resume": true, "reason": "retryable" }` |
| `resume-confirm` | `{ "resume": true, "reason": "ok" }` 或 `{ "resume": false, "reason": "capped" \| "disabled" \| "not-root" \| "disposed" \| "same-turn" }` |
| `finish` / `dispose` | `{}` |

- **C-003**：`turn-stopping` 的 `inject` 为真时，客户端 MUST 在监听器返回前完成注入。
- **C-004**：`data.trace` 由守护进程填充并已落盘；客户端 MUST NOT 重复写同一条留痕。
- **C-005**：`upstream-error` 的 `resume: true` 只表示「可以排队」，真正的投递判定 MUST 在 `resume-confirm` 中重新做一次。

## 错误码

| `code` | 触发条件 | 客户端行为 |
|---|---|---|
| `E_BAD_REQUEST` | 缺字段、类型错、`turn` 非负整数校验失败 | 记一条告警，按本地兜底 |
| `E_UNKNOWN_SESSION` | `sessionId` 未在 `turn-start` 时登记 | 自动补一次 `turn-start` 后重试一次 |
| `E_OVERSIZE` | 单行超过 64 KiB | 断开连接，转降级 |
| `E_INTERNAL` | 守护进程内部异常 | 记一条告警，按本地兜底 |

- **C-006**：任何 `E_*` 都 MUST NOT 让守护进程退出（FR-013）。

## 幂等

- **C-007**：守护进程 MUST 按 `(sessionId, turn, type)` 缓存首次成功的结果；同键再次到达时 MUST 返回缓存结果，MUST NOT 重复计数或重复写留痕。
- **C-008**：缓存 MUST 只保留最近 256 个 `(sessionId, turn, type)` 组合，超出按插入顺序淘汰。

## 连接生命周期

- **C-009**：客户端正常退出前 SHOULD 发送 `{ "type": "bye" }`；守护进程收到后立即减计数，不必等待 socket 关闭。
- **C-010**：连接断开（无论正常或异常）时，守护进程 MUST 减少连接计数并启动 30 秒宽限计时（FR-004）。
- **C-011**：宽限期内若有新连接，MUST 取消计时并继续服务。

## 兼容性

- **C-012**：新增可选字段不构成协议版本变更；删除字段、改变字段语义、改变默认行为 MUST 提升 `protocol`。
- **C-013**：客户端在 `fatal` 之后 MUST NOT 尝试重新拉起守护进程（那会在版本不兼容时变成重启循环），只在本进程内降级。
