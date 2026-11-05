# Feature Specification: 上游异常自动续行

**Feature Branch**: `006-upstream-resume`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: 「将上游异常的情况列入兼容规格，默认自动注入，注意兼容留痕」+ 设计评审补充「注入优先级仍然需要在排队任务之前」

## 背景与问题

宿主的重试层（`dsh-llm-retry`）只处理**单次模型请求**的失败：按 provider 的 `retryPolicy` 退避重试，重试耗尽后抛 `LlmError`，轮次以 `error` 结束。

这条路径**不经过收尾门**：`agent/turn-stopping` 的派发位于正常收尾路径内（`dsh-agent-loop/lib/index.js:1001`，要求 `turnEnds` 已确定且 `inbox.nextStep` 为空），而错误路径走 `catch → turnEnds = {kind:"error"} → throwError → agent/error`，不派发收尾钩子。

后果：上游抖动（限流、超时、连接中断）在重试耗尽后，任务停在半路——既没有目标状态声明，也没有任何续行提示。用户必须手动发一条「继续」才能接上。

本规格补上这一段：**在重试层之后、轮次结束之时接管一次「轮次级恢复」**，让可恢复的上游故障不再需要用户手动干预。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 上游瞬时故障后自动接上 (Priority: P1)

用户让模型执行一个长任务。中途上游返回 `RATE_LIMIT`，宿主重试若干次后仍失败，轮次以错误结束。用户没有做任何操作，几秒后模型自动继续执行剩余步骤，最终正常收尾并汇报。

**Why this priority**: 这是本规格存在的唯一理由——把「必须手动催一下」变成「自动接上」。没有它，其余需求都没有意义。

**Independent Test**: 在真实会话中触发一次可重试的上游错误（如把 provider 指向不可达地址或注入 429），观察轮次结束后是否自动开启新一轮且模型继续原任务。

**Acceptance Scenarios**:

1. **Given** 顶层 agent 的轮次因 `RATE_LIMIT` 结束，且未达续行上限，**When** 轮次进入 idle，**Then** 插件投递一条自救提醒，并自动开启新一轮。
2. **Given** 已投递续行提醒，**When** 模型读取该提醒，**Then** 提醒内容与收尾门使用的自救文案一致，包含「不是用户消息」「不构成授权」「从断点继续、不要重头再来」。
3. **Given** 续行轮次正常收尾并声明 `done`，**When** 该轮结束，**Then** 续行计数清零。

---

### User Story 2 - 不可恢复的错误与取消不空转 (Priority: P2)

上游返回 `AUTH` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED`，或用户主动取消轮次。插件不投递任何续行提醒，轮次如实结束。

**Why this priority**: 在注定失败的错误上自动续行会放大故障、空烧额度；复活用户叫停的轮次比静默中断更糟。这一条是 P1 的安全边界。

**Independent Test**: 分别注入上述错误码与一次用户取消，断言续行投递次数为 0。

**Acceptance Scenarios**:

1. **Given** 轮次因 `AUTH` 结束，**When** 进入 idle，**Then** 不投递续行提醒。
2. **Given** 用户在轮次执行中取消，**When** 轮次结束，**Then** 不投递续行提醒（该路径不派发 `agent/error`，属防御性约束，见 FR-005 实现说明）。
3. **Given** 插件被配置为 `enabled: false`，**When** 任意错误发生，**Then** 不投递续行提醒。

---

### User Story 3 - 连续失败有上限，留痕可查 (Priority: P3)

上游持续不可用。插件连续续行 3 次后停手，不再自动重试；每次判断都留下可检索的记录，用户事后能分清「续行过几次」「为什么停」。

**Why this priority**: 防止在上游长时间故障时无限重试烧额度；留痕是事后归因的唯一依据。

**Independent Test**: 连续注入 4 次可重试错误，断言前 3 次投递、第 4 次不投递，且留痕中包含 3 条续行记录与 1 条达上限记录。

**Acceptance Scenarios**:

1. **Given** 已连续续行 3 次，**When** 第 4 次可重试错误发生，**Then** 不再投递续行提醒。
2. **Given** 任意一次续行判断，**When** 查阅留痕，**Then** 能看到 outcome、reason 与错误码，且既有字段语义未变。

---

### Edge Cases

- **续行轮次自身再次失败**：计数累加，不清零；达到上限即停。
- **投递时 agent 已被 dispose**：放弃投递，不留半条消息。
- **投递前用户已发新消息并开启了新一轮**：仍然投递，但 `steer` 会把它放到最近一步，与用户消息同批时排在前面。
- **同一轮内多次 `agent/error`**：只按一次续行处理（一轮一次机会），避免同一轮重复投递。
- **`maxResumes` 配置为 0**：等于关闭自动续行，只留痕。
- **非 `LlmError` 的异常**（如 `AggregateError`、内部断言失败）：不续行。
- **`max-tokens` 结束**：属于正常收尾，由收尾门处理，不属于本规格；同时它会把续行计数清零。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 插件 MUST 监听 `agent/error`，并从事件负载中取出 `{ turn, step, error }`。
- **FR-002**: 插件 MUST 只对顶层 agent 续行；子 agent 的错误一律忽略。
- **FR-003**: 续行判定 MUST 基于 `LlmError.code`，且只接受可重试集合；集合 MUST 复用宿主默认值 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`（来源 `dsh-llm/lib/types/retry-policy.js:16-22`），不得自造第二套分类。
- **FR-004**: 非 `LlmError` 的异常 MUST 不续行。
- **FR-005**: 用户取消导致的结束 MUST 不续行。

  > **实现说明（2026-11-05 核实）**：取消路径**不派发** `agent/error`——`turn()` 的 catch 在 `abortedCancelCause(signal)` 命中时直接 `throw error`，不调用 `throwError`（`dsh-agent-loop/lib/index.js:1010-1016`）。因此本约束在真实链路上天然成立，插件内的判断是**防御性**的；对应测试只能写成单元级防御断言，不得声称获得了端到端覆盖。
- **FR-006**: 配置 `enabled: false` 时 MUST 不续行。
- **FR-007**: 续行投递 MUST 发生在轮次进入 idle 之后。宿主在 `running` 阶段对非 abort 的投递不会置 `wakeRequested`（`dsh-agent-loop/lib/index.js:845-860`），提前投递只会把消息留在队列里不生效。
- **FR-008**: 投递 MUST 使用 `agent.steer`：它在 idle 时自动开启新一轮，且与排队任务同批时排在队首——`claim()` 先取全部 `next-step`、再取一条 `next-turn`（`dsh-agent-loop/lib/index.js:104-108`）。
- **FR-009**: 同一轮次内 MUST 至多续行一次。
- **FR-010**: 插件 MUST 维护按 agent 的连续续行计数，默认上限 3，可通过 `maxResumes` 配置。
- **FR-011**: 收到任何正常 `finish` 帧（`stop` / `tool-calls` / `max-tokens`）时，计数 MUST 清零。
- **FR-012**: 达到上限后 MUST 停止续行，且 MUST NOT 向用户额外发送提示——上游错误已以错误形式暴露给用户。
- **FR-013**: 续行文案 MUST 复用收尾门的 `repairText('undeclared', attempt)`，不得新增文案常量，也不得拼接轮次、错误码等运行时数据（FR-016 的提示注入面约束同样适用）。
- **FR-014**: 每次续行判断 MUST 留痕：`outcome` 保持 `injected` / `released` 两值不变；新增 `reason` 值 `upstream-resumed`（injected）、`upstream-skipped`（released）、`upstream-capped`（released）。
- **FR-015**: 留痕 MUST 新增可选字段 `errorCode`，仅在错误路径出现；既有字段（`at` / `session` / `turn` / `outcome` / `reason` / `attempt`）的语义 MUST 保持不变。
- **FR-016**: 新增两个 volatile 配置项：`resumeOnUpstreamError`（布尔，默认 `true`）与 `maxResumes`（正整数，默认 `3`），二者 MUST 在设置页可见并即时生效。
- **FR-017**: 事件监听器内的任何异常 MUST 就地捕获并告警，MUST NOT 打断对话或阻止轮次结束。
- **FR-018**: agent 被 dispose 后 MUST 不再投递，并清理其计数状态。

### Key Entities

- **ResumeState**：按 agent 记录的连续续行状态，包含 `consecutive`（已连续续行次数）与 `lastTurn`（已处理过的轮次号，用于「一轮一次」去重）。
- **GateTraceEntry**（既有实体扩展）：新增 `errorCode` 可选字段；`reason` 枚举扩展三个值；`outcome` 不变。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 注入一次可重试的上游错误后，用户在**不做任何操作**的情况下，模型能在下一轮继续原任务（真实会话验证 1 次）。
- **SC-002**: 注入 `AUTH`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`，续行投递次数均为 **0**；取消场景按防御性单测验证（取消不派发 `agent/error`）。
- **SC-003**: 连续注入 4 次可重试错误，前 **3** 次续行、第 4 次停止；留痕中出现 3 条 `upstream-resumed` 与 1 条 `upstream-capped`。
- **SC-004**: `enabled: false` 或 `resumeOnUpstreamError: false` 时，续行投递次数为 **0**。
- **SC-005**: 既有留痕查询（按 `outcome`、按六个既有 `reason` 过滤）在改造后返回结果不变；`jq` 命令无需修改。
- **SC-006**: 自动化测试覆盖分类矩阵、上限、清零、去重、留痕六个方面，且去掉 idle 等待后至少一条用例失败（反向验证）。

## Assumptions

- 宿主为 `0.2.1-rc.5`；`agent/error` 的负载含 `{ turn, step, error }`，且 `error` 为抛出时的原始对象。
- 单次请求的重试由 `dsh-llm-retry` 负责，本规格只处理**重试耗尽后的轮次级恢复**，不重复实现退避策略。
- 续行的代价是重新发起一轮完整请求（上下文重发）。这被接受：相比用户手动催一次，自动续行省掉的正是这一次人工往返。
- 「可重试错误码」以宿主默认白名单为准；provider 若自定义了 `retryableCodes`，本插件不跟随——本插件判断的是「重试层放弃之后还值不值得再给一轮」，与「单次请求要不要重试」不是同一个问题。
