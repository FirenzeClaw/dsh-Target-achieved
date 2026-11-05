# 契约：轮次来源时序

**Feature**: 002-turn-key-alignment · **宿主**: `@deepseek-ai/dsh-agent-loop@0.2.1-rc.5`

## 时序保证

一轮内，下列事件按此顺序发生。插件的声明与判定都必须落在这个序列的正确位置。

```text
turn N 开始（phase.turn = N）
  │
  ├─ agent/assistant-stream { frame: { type: 'start', turn: N, step } }   ← 插件在此写 currentTurn = N
  │
  ├─ 模型响应 chunk…
  │     └─ 工具调用 tool-calls
  │           └─ target_status 执行（读到 currentTurn = N）✅
  │
  ├─ agent/assistant-stream { frame: { type: 'chunk', chunk: { type: 'finish' } } }
  │
  └─ agent/turn-stopping { agent, turn: N, signal }                       ← 插件按 N 取 latch
        └─ isDeclared(agent, N) ? 放行 : 注入
```

## 契约条款

| 编号 | 条款 | 违反后果 |
|---|---|---|
| C-001 | `start` 帧的 `turn` 必须等于该轮的 `turn-stopping.turn` | 声明与判定错位（本次缺陷） |
| C-002 | `start` 帧必须在任何工具执行之前发出 | 工具读不到本轮轮次 |
| C-003 | 插件在 `start` 帧写入 `currentTurn` 后，`turn-stopping` 写入同一个值 | 无害，作为兜底 |
| C-004 | 插件未观察到 `start` 帧时，`currentTurn.get(agent)` 必须为 `undefined` | 若为旧值，声明会静默落到旧键 |
| C-005 | `turn-stopping` 的 payload 必须含 `agent` 与 `turn` | 监听器无法定位状态 |

## 宿主实现依据

- `start` 帧构造：`dsh-agent-loop/lib/index.js:388-393`
- `start` 发射时机：`dsh-agent-loop/lib/index.js:1076-1083`（在 `stream(request)` 之后、chunk 循环之前）
- `turn` 自增：`dsh-agent-loop/lib/index.js:943-949`
- `turn-stopping` 派发：`dsh-agent-loop/lib/index.js:998-1004`
- payload 注入 `agent`：`dsh-agent/lib/index.js:242-246`（`fused()`）

## 验证方式

- 单元/集成：`tests/integration/turn-key.test.ts`（模拟 start 帧 → 声明 → 收尾）
- 真实会话：`quickstart.md` 的手工步骤（连续 3 轮主动声明，注入总数应为 0）
