# Phase 1 Data Model：上游异常自动续行

## ResumeState

按 agent 隔离的进程内状态，`WeakMap<Agent, ResumeState>`。不持久化：连续续行是「当前这一串失败」的度量，进程重启后归零是正确语义。

| 字段 | 类型 | 含义 | 约束 |
|---|---|---|---|
| `consecutive` | `number` | 已连续续行次数 | 非负整数；达到 `maxResumes` 后不再续行 |
| `lastTurn` | `number \| undefined` | 最近一次处理过的轮次号 | 用于「一轮至多续行一次」的幂等去重 |

**状态转移**：

```text
(无) --agent/error(可重试, 未达上限)--> { consecutive: n+1, lastTurn: turn }
     --agent/error(同一 turn 重复)-->   不变（跳过）
     --agent/error(达上限)-->          { consecutive: n, lastTurn: turn }（只留痕，不投递）
     --正常 finish 帧-->               { consecutive: 0, lastTurn: 保留 }
     --agent/disposed-->               条目删除
```

**不变式**：

- `consecutive` 只增不减，除非清零事件发生。
- `lastTurn` 只记录**已投递**或**已判定跳过**的轮次；不做历史列表（YAGNI）。
- 计数器与「遗忘计数」（`forget.ts`）互相独立：前者度量连续失败，后者度量声明延迟，清零条件不同。

## 配置项（`TargetMonitorConfig` 扩展）

| 字段 | 类型 | 默认 | volatile | 含义 |
|---|---|---|---|---|
| `resumeOnUpstreamError` | `boolean` | `true` | 是 | 总开关；关掉后错误路径只留痕不投递 |
| `maxResumes` | `number` | `3` | 是 | 连续续行上限；`0` 等价于关闭自动续行 |

**校验规则**（与既有 `enabled` / `stallNoticeThreshold` 一致）：

- 原始配置路径走 `Config` schema：`resumeOnUpstreamError` 为 `z.boolean()`，`maxResumes` 为 `z.number()`。
- 已解析路径（含 volatile 引用对象）逐字段复核：布尔引用必须 `get()` 出布尔；整数引用必须 `get()` 出非负整数，否则抛错。
- `maxResumes = 0` 合法（明确关闭），负数非法。

## 留痕条目（`GateTraceEntry` 扩展）

既有字段语义不变：

| 字段 | 类型 | 说明 |
|---|---|---|
| `at` | `string` | ISO 时间戳 |
| `session` | `string` | 8 位会话短哈希 |
| `turn` | `number` | 轮次号 |
| `outcome` | `'injected' \| 'released'` | **保持不变** |
| `reason` | `GateReason` | 扩展三个值 |
| `attempt` | `number` | 本轮第几次注入；错误路径固定 `1` |

新增可选字段：

| 字段 | 类型 | 出现条件 |
|---|---|---|
| `errorCode` | `string` | 仅在错误路径；取 `LlmError.code`，非 `LlmError` 时为 `'UNKNOWN'` |

**`reason` 取值矩阵**：

| reason | outcome | 触发条件 |
|---|---|---|
| `upstream-resumed` | `injected` | 可重试错误、未达上限、投递成功 |
| `upstream-skipped` | `released` | 不可重试码 / 非 `LlmError` / 取消 / `enabled=false` / 非顶层 / 已达上限之外的其他跳过 |
| `upstream-capped` | `released` | 可重试但已达 `maxResumes` |

**兼容性**：新增字段可缺省；新增枚举值不命中既有过滤条件；文件位置与轮转策略不变。
