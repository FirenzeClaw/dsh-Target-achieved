# Implementation Plan: 轮次键对齐

**Branch**: `002-turn-key-alignment` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-turn-key-alignment/spec.md`

## Summary

修复"声明落在错误轮次键"的缺陷：`target_status` 的轮次号当前取自 `currentTurn`，而该 WeakMap 只在 `agent/turn-stopping`（轮次**结束**时）写入，导致一轮里的第一次声明写到上一轮的键（首轮为 `0`），收尾判定读到全新的未声明状态并再次注入。

技术路线：把 `currentTurn` 的写入点前移到 `agent/assistant-stream` 的 `start` 帧——该帧由宿主在**发起模型请求之前**发出且携带本轮 `turn`，必定早于任何工具调用；`turn-stopping` 保留一次写入作为兜底。声明工具与收尾判定因此共用同一个轮次来源。

## Technical Context

**Language/Version**: TypeScript 5.9（ESM，Node 24）

**Primary Dependencies**: `@deepseek-ai/cordis ~4.0.5`（插件模型）、`@deepseek-ai/dsh-agent`（Agent/事件面）、`@deepseek-ai/dsh-llm`（消息与 FinishReason）、`@deepseek-ai/dsh-tools`（工具注册）、`@deepseek-ai/dsh-system-prompt`（提示词章节）

**Storage**: 无持久化；轮次状态只存进程内 `WeakMap`

**Testing**: `npm test`（`node --test`，Node 原生类型剥离）

**Target Platform**: 宿主 DeepSeek-Harness 0.2.1-rc.5，Linux 桌面

**Project Type**: 单包 DSH 插件（`src/` 8 个模块，`tests/` 单测 + 集成）

**Performance Goals**: 收尾判定 O(1) 内存查找，不引入额外 I/O

**Constraints**: 监听器内异常必须就地捕获；不得解析助手文本判定完成；不得改动宿主安装目录

**Scale/Scope**: 单会话每轮一次判定；改动集中在 `src/index.ts`（轮次来源）与 `src/tool.ts`（拒绝无轮次调用），预计 < 40 行

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 检查 | 结论 |
|---|---|---|
| I 简单性优先 | 复用既有 WeakMap 与既有事件订阅，不新增状态机 | ✅ |
| II 测试先行 | 先写"声明后收尾不得注入"的失败测试，再改实现 | ✅ 见 tasks T1–T3 |
| III 提示面与状态安全 | 不改注入预算、不改三种状态语义、不新增注入面 | ✅ |
| IV 原子提交 | 一个提交：修复 + 回归测试 + 文档 | ✅ |
| V 不审查不合并 | 触碰轮次边界，需过安全轴；含回归测试与全绿要求 | ✅ |
| VI 可读性与显式契约 | `turnOf` 语义改为"本轮轮次"；无轮次时显式拒绝而非写哨兵键 | ✅ |
| VII 复用宿主机制 | 复用既有 `agent/assistant-stream` 订阅，不新增订阅点 | ✅ |

**初判通过**，无需要豁免的违规。

## Project Structure

### Documentation (this feature)

```text
specs/002-turn-key-alignment/
├── spec.md              # 需求
├── plan.md              # 本文件
├── research.md          # Phase 0：轮次来源核实
├── data-model.md        # Phase 1：轮次状态模型
├── quickstart.md        # Phase 1：验证步骤
├── contracts/
│   ├── turn-source.contract.md
│   └── target-status.tool.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks 生成
```

### Source Code (repository root)

```text
src/
├── index.ts    # 轮次来源：start 帧写入 currentTurn，turn-stopping 兜底
├── tool.ts     # 无轮次时显式拒绝；其余不变
├── state.ts    # 不变（latch 以 turn 为键）
└── gate.ts     # 不变（按 turn 取 latch）
tests/
├── unit/                 # 已有
└── integration/
    └── turn-key.test.ts  # 新增：声明先于收尾的回归测试
```

**Structure Decision**: 沿用既有单包结构，不新增模块。修复面限定在 `src/index.ts` 的轮次写入点与 `src/tool.ts` 的前置校验。

## Phase 0: Research

见 [research.md](./research.md)。核心结论：

- `agent/assistant-stream` 的 `start` 帧在 `live.start()` 时发出，位于发起模型请求之后、chunk 循环之前（`dsh-agent-loop/lib/index.js:1076-1083`），**早于**模型响应中的任何工具调用。
- `start` 帧携带 `{ attemptId, revision, turn, step }`（`dsh-agent-loop/lib/index.js:388-393`）。
- `turn` 由 `turn()` 自增并写入 `phase.turn`（`dsh-agent-loop/lib/index.js:943-949`），与 `turn-stopping` 派发时的 `turn` 是同一变量。
- `agent/turn-stopping` 的 payload 由 `agentEvents` 的 `fused()` 注入 `agent`（`dsh-agent/lib/index.js:242-246`），监听器能拿到 agent。

## Phase 1: Design & Contracts

- [data-model.md](./data-model.md)：轮次键、轮次状态、声明的生命周期
- [contracts/turn-source.contract.md](./contracts/turn-source.contract.md)：轮次来源的时序契约
- [contracts/target-status.tool.md](./contracts/target-status.tool.md)：工具返回与拒绝语义
- [quickstart.md](./quickstart.md)：可运行的验证步骤

### 变更点（实现阶段执行）

1. `src/index.ts`：在 `agent/assistant-stream` 的 `start` 帧分支写 `currentTurn.set(payload.agent, frame.turn)`；`turn-stopping` 保留写入作为兜底。
2. `src/tool.ts`：`turnOf(agent)` 无值时抛 `TARGET_STATUS_NO_TURN`，而不是写入 `0`。
3. 新增 `tests/integration/turn-key.test.ts`：先声明后收尾不得注入；未声明时仍注入；轮次变化后声明不继承。

### 兼容性

- `target_status` 参数与返回结构不变（`ok`/`turn`/`state`），只是 `turn` 从"可能是上一轮"变成"一定是本轮"。
- 已声明 `inject: ['agents', 'tools', 'systemPrompt']` 不变。
- 无新增依赖。

## Complexity Tracking

> 无违规，无需填写。
