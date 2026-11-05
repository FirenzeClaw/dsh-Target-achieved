# Tasks: 轮次键对齐

**Input**: Design documents from `specs/002-turn-key-alignment/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: 本特性强制 TDD（项目宪法原则 II），测试任务不可省略。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 对应 spec.md 的用户故事（US1 / US2 / US3）
- 每条任务都带确切文件路径

## Phase 1: Setup

- [x] T001 确认宿主契约：核实 `agent/assistant-stream` 的 `start` 帧携带 `turn` 且早于工具调用，记录于 `specs/002-turn-key-alignment/research.md`
- [x] T002 创建规格与设计产物：`specs/002-turn-key-alignment/{spec,plan,research,data-model,quickstart}.md` 与 `contracts/`

---

## Phase 2: Foundational

**目的**: 先把"轮次来源"抽成可测的单点，后续故事都依赖它

- [x] T003 在 `src/index.ts` 中把 `currentTurn` 的类型改为 `WeakMap<Agent, number>` 并新增 `turnOf` 访问器，返回 `number | undefined`（与现有 `currentTurn.get(agent) ?? 0` 区分开）
- [x] T004 在 `tests/integration/turn-key.test.ts` 建立测试骨架：复用 `turn-gate.test.ts` 的假 agent 风格，提供 `emitStartFrame(agent, turn)` 与 `triggerTurnStopping(agent, turn)` 两个辅助函数

**Checkpoint**: 轮次来源成为可注入、可断言的单点

---

## Phase 3: User Story 1 - 主动声明后不再被催促 (P1) 🎯 MVP

**Goal**: 助手在轮次内任意时刻声明后，收尾判定不再注入

**Independent Test**: 模拟 `start` 帧 → 声明 `done` → 触发收尾判定 → 断言无注入

### Tests for User Story 1

- [x] T005 [US1] 在 `tests/integration/turn-key.test.ts` 写失败测试：`start` 帧（turn=7）→ `declare(agent, 7, 'done')` → `handleTurnStopping` 返回 `false` 且未调用 `deliver`
- [x] T006 [P] [US1] 在 `tests/integration/turn-key.test.ts` 写失败测试：同一流程下声明 `awaiting_user` 同样不注入
- [x] T007 [US1] 运行 `npm test`，确认 T005/T006 失败（RED），记录失败输出

### Implementation for User Story 1

- [x] T008 [US1] 在 `src/index.ts` 的 `agent/assistant-stream` `start` 分支写 `currentTurn.set(payload.agent, frame.turn)`，同时保留 `streamTurn` 或合并为单点（按 research 决策 1）
- [x] T009 [US1] 运行 `npm test`，确认 T005/T006 转绿（GREEN）

**Checkpoint**: US1 独立可验证——声明被尊重

---

## Phase 4: User Story 2 - 声明与判定同一坐标系 (P1)

**Goal**: 工具返回的轮次号恒等于本轮轮次

**Independent Test**: 轮次开头声明返回 N；注入后再声明仍返回 N；新一轮声明返回 N+1

### Tests for User Story 2

- [x] T010 [P] [US2] 在 `tests/integration/turn-key.test.ts` 写失败测试：`start` 帧（turn=7）后立即调用工具，断言返回 `turn === 7`
- [x] T011 [P] [US2] 在 `tests/integration/turn-key.test.ts` 写失败测试：未收到任何 `start` 帧时调用工具，断言抛 `TARGET_STATUS_NO_TURN`
- [x] T012 [US2] 在 `tests/integration/turn-key.test.ts` 写失败测试：turn 7 声明 `done` 后进入 turn 8，断言 `latchOf(agent, 8).state === 'working'`

### Implementation for User Story 2

- [x] T013 [US2] 在 `src/tool.ts` 中把 `turnOf` 的返回类型改为 `number | undefined`，为 `undefined` 时抛 `TARGET_STATUS_NO_TURN`
- [x] T014 [US2] 在 `src/index.ts` 更新 `registerTargetStatus` 调用处，传入新的 `turnOf`
- [x] T015 [US2] 运行 `npm test`，确认 T010–T012 转绿

**Checkpoint**: US1 + US2 均独立可验证

---

## Phase 5: User Story 3 - 缺陷可被自动化重现 (P2)

**Goal**: 回归测试在未修复实现上失败、修复后通过

**Independent Test**: 注释掉 `src/index.ts` 的 `start` 帧写入，`npm test` 必须失败；恢复后通过

### Tests for User Story 3

- [x] T016 [US3] 反向验证：临时注释 `T008` 的代码，运行 `npm test` 确认 T005/T010 失败，记录输出后恢复
- [x] T017 [US3] 在 `tests/integration/turn-key.test.ts` 顶部 JSDoc 写明本文件锁定的缺陷与对应 spec 编号

**Checkpoint**: 缺陷被测试钉死

---

## Phase 6: Polish

- [x] T018 [P] 更新 `AGENTS.md` §构建与运行 的实测状态（测试总数、已修复项）
- [x] T019 [P] 在 `docs/PLUGIN-DESIGN.md` 追加"轮次来源"决策记录（为什么用 `start` 帧而非 `turn-stopping`）
- [x] T020 运行 `npm run typecheck && npm run build && npm test`，三项全绿
- [ ] T021 按 `quickstart.md` 的手工步骤在真实会话验证（需重启 `dsh web`）

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup（T001–T002）已完成
- Foundational（T003–T004）阻塞所有故事
- US1（T005–T009）→ US2（T010–T015）→ US3（T016–T017）→ Polish（T018–T021）
- US2 依赖 US1 的 `currentTurn` 写入点（T008），但测试可先写

### Within Each User Story

- 先写测试并看到失败（RED）→ 再改实现（GREEN）
- 同一文件的测试任务不标 [P]（`turn-key.test.ts` 是单文件，T005/T006 按顺序追加）

### Parallel Opportunities

- T006 与 T005 同文件，不并行
- T010 / T011 / T012 同文件，不并行
- T018 / T019 不同文件，可并行
- T020 / T021 不可并行（T021 依赖 T020 的构建产物）

---

## Implementation Strategy

### MVP First

1. Foundational（T003–T004）
2. US1（T005–T009）→ 此时"主动声明被尊重"已成立，核心缺陷消失
3. **STOP and VALIDATE**：`npm test` 通过，退出码 0

### Incremental Delivery

1. US1 → 核心价值（不再每轮催一次）
2. US2 → 契约收紧（工具报告正确轮次、无轮次显式报错）
3. US3 → 防回归
4. Polish → 文档与真实会话验证

---

## Notes

- 全部任务完成后，`npm test` 应为 47 + 新增测试数，`fail 0`
- 真实会话验证（T021）需要用户重启 `dsh web`，因为 `dsh-hmr` 的 `root: []` 不监听 `dist/`
- 缺陷二（首次收尾未触发监听器）不在本任务表内（2026-11-05 复核：该缺陷不成立，结论已撤销）
