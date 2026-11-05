# Contract：续行判定与投递

**Scope**: `agent/error` → 分类 → 计数 → 投递。每条都是可断言的行为承诺。

## C-001 触发点

- MUST 只监听 `agent/error`，payload 形如 `{ agent, turn, step, error }`（`agent` 由 scoped dispatch 注入，见 `dsh-agent-loop/lib/index.js:877-885`）。
- MUST NOT 监听 `agent/request-error`：那是 `dsh-llm-retry` 的职责（`dsh-llm-retry/lib/index.js:175`），重复挂载会与其退避策略冲突。

## C-002 分类

- `error instanceof LlmError` 且 `error.code ∈ RETRYABLE_CODES` → 可续行。
- `RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']`，与宿主 `DEFAULT_RETRYABLE_CODES`（`dsh-llm/lib/types/retry-policy.js:16-22`）逐项一致。
- 其余（含非 `LlmError`、`AUTH`、`QUOTA`、`ACCOUNT_QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`UNKNOWN`）→ 不续行。

## C-003 前置条件（全部满足才续行）

1. `config.enabled` 为真；
2. `config.resumeOnUpstreamError` 为真；
3. agent 属于 `ctx.agents.roots()`；
4. `consecutive < maxResumes`；
5. `lastTurn !== turn`（同一轮不重复处理）；
6. agent 未被 dispose。

任一不满足 → 留痕 `upstream-skipped` 或 `upstream-capped`，不投递。

## C-004 投递时序

- MUST 在 `agent.whenIdle()` 兑现之后投递。
- MUST NOT 在 `agent/error` 监听器内同步投递：`phase.kind === "running"` 时 `wakeDriver` 不置 `wakeRequested`（`dsh-agent-loop/lib/index.js:854-860`），消息不会生效。
- 投递方式 MUST 为 `agent.steer(message)`：idle 时自动起一轮，且 `claim()` 先取全部 `next-step` 再取一条 `next-turn`（`dsh-agent-loop/lib/index.js:103-108`），因此排在同批排队任务之前。

## C-005 投递前复核

`whenIdle` 兑现后、投递前 MUST 重新检查 C-003 的第 1、2、3、5、6 项。理由：等待期间用户可能已经取消、关闭开关或手动继续；此时再投递就是越权。

## C-006 文案

- MUST 复用 `repairText('undeclared', 1)`；不新增文案常量。
- MUST NOT 拼接轮次号、错误码、错误 message 等运行时数据（提示注入面约束）。
- MUST 用 `createNotice(text, summary)` 构造，保留来源标记与 `source` 归属。

## C-007 计数

- 投递成功 → `consecutive += 1`，`lastTurn = turn`。
- 收到正常 `finish` 帧（`stop` / `tool-calls` / `max-tokens`）→ `consecutive = 0`。
- `error` / `aborted` → 不清零。
- `agent/disposed` → 删除该 agent 的条目。

## C-008 上限

- `consecutive >= maxResumes` → 不再投递，留痕 `upstream-capped`。
- 达上限时 MUST NOT 向用户额外发送提示：上游错误已以错误形式暴露给用户。
- `maxResumes = 0` 时行为等价于关闭自动续行。

## C-009 异常隔离

- 监听器内任何异常 MUST 就地 `catch` 并 `console.warn`，MUST NOT 阻止 `agent/error` 的传播或打断轮次结束。
- 留痕写盘失败不影响投递决策（沿用 `recordTrace` 既有的 `sinkFailed` 语义）。
