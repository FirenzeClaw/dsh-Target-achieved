# Phase 0 Research：上游异常自动续行

全部结论来自本机已安装的宿主源码（`@deepseek-ai/dsh` 0.2.1-rc.5），路径均在
`/home/firenzeclaw/.nvm/versions/node/v24.22.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 之下（下文省略前缀）。

## R-001 错误路径是否派发 `agent/turn-stopping`

**Decision**: 不派发。续行必须挂在另一个事件上。

**Rationale**:
- `dsh-agent-loop/lib/index.js:1000-1007`：`if (turnEnds && this.inbox.nextStep.length === 0) { await this.dispatch.serial("agent/turn-stopping", ...) }` 位于 `try` 内，只有正常收尾才走到。
- 错误路径：`dsh-agent-loop/lib/index.js:1013-1032` 的 `catch` 先把 `turnEnds` 置为 `{kind:"error"}`（1019），随后 `this.throwError(error)`；`throwError`（877-885）只 `emit("agent/error", { turn, step, error })` 然后重新抛出。
- 因此现有收尾门在错误路径上完全不会运行——这也解释了为什么「上游断流」在 README 里被标为「只覆盖到重试层之前」。

**Alternatives considered**:
- 在 `agent/turn-stopping` 里兜底：不可能，事件根本不发。
- 在 `agent/status` 的 `idle` 转换上判断：可以，但拿不到错误信息，无法分类；`agent/error` 才有 `error` 对象。

## R-002 `running` 阶段投递为什么不生效

**Decision**: 续行投递必须等轮次真正 idle。

**Rationale**:
- `send`（`dsh-agent-loop/lib/index.js:800-805`）先算 `wakingAfterAbort = wakeup && phase.kind !== "idle" && phase.abort.signal.aborted`，再 `wakeDriver(wakingAfterAbort)`。
- `wakeDriver`（854-860）在 `phase.kind !== "idle"` 时，只有 `maintenance` 或 `wakeAfterAbort` 才置 `wakeRequested`；上游错误不是 abort，两者都不成立。
- `kick()` 的 `finally`（899-908）只在 `wakeRequested && inbox.hasPending` 时重启驱动。
- 结论：在 `agent/error` 监听器里同步 `steer`/`followup`，消息只会躺在队列里，等下一次用户输入才被消费——那就不是「自动续行」了。

**Alternatives considered**:
- `setTimeout(0)`：依赖事件循环与 `kick().finally` 的相对顺序，脆弱。
- `queueMicrotask`：同上，且 `throwError` 之后的传播链跨越多个 await。
- `whenIdle()`（`dsh-agent-loop/lib/index.js:863-868`）：语义明确——「当前活动结束」，且会跟随其后的唤醒工作。**选用**。

## R-003 idle 后如何唤醒，且排在排队任务之前

**Decision**: 用 `agent.steer(message)`，不用 `agent.followup`。

**Rationale**:
- `followup` = `send(input, "next-turn", true)` → `inbox.splice("next-turn", Infinity, 0, [message])`，`Infinity` 会被钳到数组长度 → **追加到队尾**；若此时已有排队任务，续行提醒会排在它们之后。
- `steer` = `send(input, "next-step", true)` → 进入 `next-step`；idle 时 `wakeDriver` 直接起一轮（854-860 的 idle 分支）。
- `claim`（103-108）在 `target === "next-turn"` 时先取**全部** `next-step`，再取**一条** `next-turn`。所以 steer 的消息与排队任务同批时排在最前面，且只消耗本轮的「一条 next-turn 名额」，不会把排队任务一次吞掉。
- 这正好满足用户补充的约束「注入优先级仍然需要在排队任务之前」。

**Alternatives considered**:
- `followup`：语义更贴近「排入下一轮」，但顺序在队尾，被否。
- `inbox.prepend("next-turn", ...)`：顺序对，但 `prepend` 不唤醒驱动，消息会一直悬着。
- 直接调 `wakeDriver`：类型上是 `private`（`dsh-agent-loop/lib/types/agent.d.ts:54`），不能碰。

## R-004 错误分类用什么字段

**Decision**: `error instanceof LlmError` 且 `error.code ∈ {EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT}`。

**Rationale**:
- `dsh-llm/lib/types/index.js:66` 的 `LlmError` 继承 `HarnessError`，带稳定 `code`（不可解析 message）；构造处 `dsh-agent-loop/lib/index.js:1136-1137`：`if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)`。
- 可重试码白名单是宿主的既有默认值：`dsh-llm/lib/types/retry-policy.js:16-22`（`DEFAULT_RETRYABLE_CODES`）。复用它，就不需要维护第二套分类。
- 非 `LlmError`（`AggregateError`、内部断言）没有可信分类，保守不续行。

**Alternatives considered**:
- 按 `error.message` 关键词匹配：脆弱且与「禁止解析文本」的既有约定冲突。
- 跟随 provider 自定义 `retryableCodes`：本插件判断的是「重试层放弃后还值不值得再给一轮」，与「单次请求要不要重试」是两个问题；跟随会让配置面翻倍。规格 Assumptions 已写明。

## R-005 与 `dsh-llm-retry` / `dsh-goal-round-driver` 的边界

**Decision**: 不注册 `agent/request-error`，只在其耗尽后补一层；不碰 goal 状态机。

**Rationale**:
- `dsh-llm-retry/lib/index.js:175` 已在该 waterfall 上按 provider 策略退避重试（默认 `maxRetries: 5`）。再挂一个监听器要么与它抢时序，要么重复退避逻辑，违反原则 VII。
- `dsh-goal-round-driver` 负责「goal 未完成时排入 `<goal_round>`」，它的触发条件是 idle + goal active + 有额度；与本插件会在同一轮结束时都想投递。仲裁：本插件只在 `agent/error` 后投递一次，且 `maxResumes` 上限 3；goal driver 走 `followup`（队尾）。二者同时存在时，steer 的续行消息在队首、goal round 在其后，不会互相触发——因为续行消息本身不带 goal 语义，模型读到后要么继续工作、要么声明收尾。

**Alternatives considered**:
- 在 `request-error` 中接管：会与 `dsh-llm-retry` 的 `retryPolicy.mode === "always"` 分支冲突。
- 复用 goal 机制（把上游失败包装成 goal blocked）：需要创建 goal，而 `create_goal` 要求顶层人类直接请求（见 AGENTS.md 宿主事实），插件不能自己造。

## R-006 留痕如何扩展才不破坏既有查询

**Decision**: `outcome` 保持两值；新增三个 `reason`；新增可选 `errorCode`。不新建文件、不加版本号。

**Rationale**:
- README 公开的查询是 `jq -c 'select(.turn == 7)'` 与按 `outcome` / `reason` 过滤；新增枚举值不会命中旧过滤条件，旧命令照常工作。
- `trace.ts` 的 `GateReason` 是联合类型，追加值不会改变既有字段语义。
- `errorCode` 用可选字段，老记录没有该键，消费者读到 `undefined`——JSONL 消费方（jq）天然容忍。

**Alternatives considered**:
- 另开 `error-trace.jsonl`：会让「查某轮发生了什么」变成两次查询，且 README 的排查指引要改。否。
- 加 `v: 2` 版本字段：当前只有一种格式，加版本号是为不存在的消费者服务（YAGNI）。

## R-007 计数什么时候清零

**Decision**: 收到任何正常 `finish` 帧（`stop` / `tool-calls` / `max-tokens`）即清零；`error` / `aborted` 不清零。

**Rationale**:
- 清零的含义是「上游恢复过」——一次成功的模型响应就是最直接的证据。
- 现有 `agent/assistant-stream` 的 `chunk` 帧已带 `finish`（`src/cause.ts` 的 `finishOf` 在用），无需新监听点。
- `max-tokens` 虽然是异常终止，但它证明上游是通的，因此也清零。

**Alternatives considered**:
- 在 `turn-stopping` 里清零：错误路径不派发该事件，正常轮次才派发——等价，但 `assistant-stream` 更早、且不依赖门是否启用。

## R-008 一轮只续一次如何实现

**Decision**: `ResumeState.lastTurn` 记录已处理过的轮次号；同一 `turn` 再次 `agent/error` 直接跳过。

**Rationale**: `agent/error` 可能在同一次失败中被多处 `throwError` 触发（例如 `turn/end` 追加失败时 1013 与 1034 都会调用）。用轮次号去重是最小成本的幂等手段，且轮次号已由 `src/turn.ts` 提供。
