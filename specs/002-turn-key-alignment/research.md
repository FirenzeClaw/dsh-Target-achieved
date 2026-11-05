# Phase 0 Research: 轮次来源

**Feature**: 002-turn-key-alignment · **Date**: 2026-11-05

## 问题

工具 `target_status` 与收尾门 `handleTurnStopping` 必须使用同一个轮次标识。当前实现里，工具的轮次来自 `currentTurn` WeakMap，而它只在 `agent/turn-stopping` 中写入——那是轮次结束的时刻。因此一轮内第一次声明必然读到上一轮的值（首轮为哨兵 `0`）。

**待答**：在工具调用之前，插件能否拿到当前轮次号？

## 决策 1：用 `agent/assistant-stream` 的 `start` 帧作为轮次来源

**Decision**: 在 `agent/assistant-stream` 的 `start` 帧分支写 `currentTurn`，`turn-stopping` 保留写入兜底。

**Rationale**（宿主源码核实，`@deepseek-ai/dsh-agent-loop@0.2.1-rc.5`）：

- 发射点：`live.start()` 位于 `preparedCall.stream(request)` 之后、`for await (const chunk of stream)` 之前（`dsh-agent-loop/lib/index.js:1076-1083`）。即**模型请求刚发出、尚未返回任何 chunk**。
- 帧结构：`{ type: 'start', attemptId, revision, turn, step }`（`dsh-agent-loop/lib/index.js:388-393`），`turn` 直接带在帧上。
- 工具调用只可能出现在模型响应之后（chunk 里的 `tool-calls`），因此 `start` 帧必定早于本轮任何 `target_status` 调用。
- 插件**已经**订阅了该事件（用于 `recordFinish`），复用它不新增订阅点。

**Alternatives considered**:

1. 在 `agent/pre-step` 里取轮次 —— 未核实该事件 payload 是否携带 `turn`，且它是 waterfall 模式，介入有副作用风险。放弃。
2. 工具内回退到 `streamTurn`（插件已有的另一个 WeakMap）—— 可行但语义重复：两个 WeakMap 记同一件事。不如合并为单一来源。放弃。
3. 让收尾门去读工具的键（反向对齐）—— 收尾门拿不到工具的调用记录，且会把"声明"与"判定"的依赖倒置。放弃。
4. 用 `session.append` 的 turn 事件推导 —— 需要额外的会话日志订阅，复杂度更高。放弃。

## 决策 2：无轮次时显式拒绝

**Decision**: `turnOf(agent)` 返回 `undefined` 时，工具抛 `TARGET_STATUS_NO_TURN`，不写哨兵键 `0`。

**Rationale**: 修复后 `currentTurn` 在 `start` 帧即被写入，正常路径不会走到这里。若仍走到，说明宿主契约变化或调用发生在任何轮次之外——此时静默写入 `0` 会让声明落到一个永远无人读取的键上，症状与本次缺陷完全相同且更难排查。显式拒绝把问题暴露在调用点。

**Alternatives considered**:

- 允许写 `0` 并同时写入 `streamTurn` —— 掩盖契约异常，放弃。
- 用 `-1` 之类的其他哨兵 —— 只是换了个魔法值，放弃。

## 决策 3：`turn-stopping` 兜底写入保留

**Decision**: `currentTurn.set(payload.agent, payload.turn)` 在 `turn-stopping` 里保留。

**Rationale**: 若宿主某条路径不经过 `assistant-stream`（例如极早期的失败轮），收尾判定仍需一个正确的轮次。两处写入同源（都来自宿主的 `turn` 变量），不会互相矛盾；`start` 帧先写，`turn-stopping` 后写同一个值。

## 决策 4：回归测试的形态

**Decision**: 新增 `tests/integration/turn-key.test.ts`，用与既有 `turn-gate.test.ts` 相同的替身风格，直接驱动 `handleTurnStopping` + `declare`，并断言 `turnOf` 在 `start` 帧后可读。

**Rationale**: 既有集成测试已经建立了"假 agent + 真 gate"的模式，复用它可以不引入测试框架、不启动真实会话。该测试在未修复实现上必须失败（`turn` 为 `undefined`/`0` 时声明落到别处，收尾判定注入），修复后通过。

**未采用**: 启动真实会话的端到端测试 —— 依赖模型调用，不稳定且慢，留给 quickstart 的手工验证步骤。

## 遗留（不在本规格范围）

**缺陷二**：插件加载后的首次收尾未触发监听器（11:53 加载，11:54 那轮结束无注入，直到 12:00 才第一次触发）。已知 `agent/turn-stopping` 的 payload 由 `fused()` 注入 `agent`，且根上下文监听器应通过 `scopeTarget` 过滤（`scopeOf(ctx) === undefined` 时放行）。原因待查，单独开规格。

> 2026-11-05 复核：以上结论**不成立**——11:53 加载后的第一轮（turn 3）正常注入，未注入的 turn 2 结束于 11:46（早于加载 7 分钟）。结论已撤销，勿据此排查（见 `AGENTS.md`）。
