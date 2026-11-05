# Data Model: 轮次键对齐

**Feature**: 002-turn-key-alignment · **Date**: 2026-11-05

## 实体

### Turn Key（轮次标识）

| 属性 | 类型 | 来源 | 约束 |
|---|---|---|---|
| `turn` | `number` | 宿主 `agent/assistant-stream` 的 `start.turn`；`agent/turn-stopping` 的 `turn` 兜底 | 同一轮内恒定；随轮次单调递增；不得为哨兵值 |

**生命周期**：进程内有效，不持久化。轮次结束时无需清理——下一次写入直接覆盖同一 agent 的值。

**不变量（本规格的核心）**：

> 任意时刻，`currentTurn.get(agent)` 必须等于该 agent 当前正在进行的轮次号；若插件尚未观察到任何轮次，则为 `undefined`（而不是 `0`）。

### Turn Latch（轮次状态）

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn` | `number` | 创建它时的轮次号 |
| `state` | `'working' \| 'done' \| 'awaiting_user'` | 目标状态，缺省 `working` |
| `repairs` | `number` | 本轮已发自救提醒次数 |
| `noticeShown` | `boolean` | "可能卡住"提示是否已展示 |

**规则**：

- `latchOf(agent, turn)` 在 `turn` 与既有 latch 不符时整体重建（`src/state.ts`，已实现且不改）。
- 因此只要写入方与读取方用同一个 `turn`，声明与判定必然对齐。

### Declaration（声明）

| 属性 | 类型 | 说明 |
|---|---|---|
| `state` | `'done' \| 'awaiting_user'` | 只能由 `target_status` 写入 |
| `turn` | `number` | 写入时由 `currentTurn` 提供，必须等于当前轮次 |

**状态转换**：

```text
working ──declare(done)──────────▶ done
working ──declare(awaiting_user)─▶ awaiting_user
done    ──declare(awaiting_user)─▶ awaiting_user   （同轮覆盖）
awaiting_user ──declare(done)────▶ done            （同轮覆盖）
任意状态 ──轮次 +1──────────────▶ working          （构造性重置）
```

## 校验规则

| 规则 | 断言 | 对应需求 |
|---|---|---|
| 工具报告的轮次等于当前轮次 | `target_status` 返回的 `turn === currentTurn.get(agent)` | FR-001 / SC-002 |
| 声明对收尾可见 | 声明后触发 `handleTurnStopping`，`isDeclared(agent, turn) === true` | FR-002 / FR-003 |
| 同轮覆盖 | 连续两次声明，后者生效，`turn` 不变 | FR-004 |
| 跨轮不继承 | 轮次 +1 后 `latchOf(agent, newTurn).state === 'working'` | FR-005 |
| 无轮次拒绝 | `currentTurn` 为 `undefined` 时抛 `TARGET_STATUS_NO_TURN` | FR-006 |

## 不涉及的数据

- 不新增持久化结构。
- 不改变会话日志中的消息结构（注入仍走 `agent.steer` / `inbox.prepend`）。
