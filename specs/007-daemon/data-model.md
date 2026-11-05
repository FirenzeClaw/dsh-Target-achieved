# Phase 1 数据模型：跨进程监测守护

## 实体

### SessionBinding

一条客户端连接上登记的会话。

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string | 来自 `agent.id`（`SessionId`） |
| `clientId` | string | 客户端进程标识，连接时生成（`pid` + 随机后缀） |
| `pid` | number | 客户端进程号，用于诊断 |
| `connectedAt` | number | 连接建立时刻（毫秒） |
| `protocol` | number | 握手声明的协议版本 |

关系：一个连接可登记多个会话（同一 DSH 进程可能同时跑多个 agent）；一个会话只属于一个连接。

### MonitorState

判定状态的唯一载体，**只存在于守护进程**（降级时存在于客户端进程）。

| 字段 | 类型 | 说明 | 来源需求 |
|---|---|---|---|
| `sessionId` | string | 主键之一 | FR-007 |
| `forgetCount` | number | 累计「注入后成功声明」次数 | 005 既有 |
| `pendingAt` | number \| null | 上次注入时刻，等待反应窗口 | 005 既有 |
| `resumeConsecutive` | number | 连续上游失败续行次数 | 006 既有 |
| `lastResumeTurn` | number \| null | 已处理过的轮次（去重） | 006 既有 |
| `lastTurn` | number \| null | 最近一次观察到的轮次 | 002 既有 |
| `declared` | boolean | 当前轮次是否已声明 | 001 既有 |
| `declaredState` | `'done' \| 'awaiting_user' \| null` | 声明的具体状态 | 001 既有 |

**状态转移**（与既有实现一致，迁移时不改语义）：

1. 轮次开始（`turn-start`）：`declared = false`，`declaredState = null`，`lastTurn = turn`。
2. 收到声明（`declare`）：若 `pendingAt` 非空且 `now - pendingAt <= reactionWindowMs`，则 `forgetCount += 1` 并清空 `pendingAt`；`declared = true`，`declaredState = state`。
3. 收尾判定（`turn-stopping`）：读 `declared` 决定是否注入；注入时 `pendingAt = now`。
4. 上游错误（`upstream-error`）：`resumeConsecutive += 1`，记录 `lastResumeTurn`。
5. 正常结束（`finish: stop|tool-calls|max-tokens`）：`resumeConsecutive = 0`。
6. 连接断开：该 `clientId` 名下状态**保留**（用户可能马上重连），但超过 24 小时无访问则回收（内存上限保护）。

### TraceRecord

与 004 既有结构保持一致，新增一个字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `at` | number | 时间戳 |
| `session` | string | 会话标识（sha256 前 8 位，沿用既有脱敏方式） |
| `turn` | number | 轮次 |
| `outcome` | `'injected' \| 'released'` | 是否注入 |
| `reason` | `GateReason` | 判定原因（六种既有 + 三种上游） |
| `attempt` | number | 本轮第几次注入 |
| `errorCode` | string? | 上游错误码（仅上游路径） |
| `degraded` | boolean? | **新增**：是否由客户端本地写入（FR-011） |

### DaemonEndpoint

守护进程的对外地址与元信息。

| 字段 | 类型 | 说明 |
|---|---|---|
| `socketPath` | string | `$DSH_HOME/run/target-monitor.sock` |
| `pidPath` | string | `$DSH_HOME/run/target-monitor.pid` |
| `pid` | number | 写入 pid 文件，供清理时二次确认 |
| `protocol` | number | 当前实现支持的协议版本 |

## 校验规则

- `sessionId` 必须是非空字符串，长度 ≤ 128；超长直接拒绝（防止异常 payload 撑爆内存键表）。
- `turn` 必须是非负整数。
- `config` 快照必须包含全部七个字段且类型正确；缺失或非法时按客户端默认值补齐，并在响应里注明（守护进程不能因为一个字段缺失就拒绝服务）。
- `reactionWindowMs`、阈值类字段必须是正整数；`maxResumes` 允许 0。
- `requestId` 必须是 `clientId:序号` 形式，用于幂等去重。

## 一致性约束

- **单写者**：`MonitorState` 与 `TraceRecord` 的写入只在守护进程内发生（降级时在客户端进程内，且带 `degraded` 标记）。不存双向同步，因为那需要冲突解决，而冲突解决需要版本向量——为一个本机 IPC 引入版本向量不划算。
- **切换代价**：客户端从远程切到本地（降级）时，本地状态从零开始。规格接受这一点（US3 场景 1 只要求功能可用，不要求计数延续）。
- **切换方向单向**：一个进程一旦降级，本进程内不再回到远程（FR-012）；新进程重新尝试。
