# Tasks: 目标达成监测器（收尾门）

**Input**: Design documents from `/specs/001-target-monitor/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: 本项目宪法 II 强制 TDD（"没有失败的测试就不写生产代码"），因此每个故事都包含测试任务，且测试必须先写、先看到失败。

**Organization**: 按用户故事分组，每个故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1–US5）

## Path Conventions

单项目结构：`src/`、`tests/` 在仓库根目录（见 plan.md §Project Structure）。

> **修订记录（2026-11-05）**：`/speckit-analyze` 发现 FR-009 / FR-013 / FR-014 三条 MUST NOT 零覆盖，且 `tests/unit/prompt.test.ts` 被三个任务"扩充"却无人创建。本版补入 T014（创建该文件）、T019（FR-014）、T032（FR-009）、T036（FR-013），任务编号顺延重排为 T001–T045。

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 建立可构建、可测试的最小工程骨架。当前仓库只有文档，无 `package.json`。

- [X] T001 创建 `package.json`：`"type": "module"`、`exports` 指向 `./dist/index.js` 与 `./dist/index.d.ts`、`files: ["dist"]`、`scripts.build = "tsc -p tsconfig.json"`、`scripts.test = "node --test"`、`scripts.typecheck = "tsc -p tsconfig.json --noEmit"`；`@deepseek-ai/{cordis,schemastery,dsh-agent,dsh-llm,dsh-tools,dsh-system-prompt}` 声明为 `peerDependencies`（版本对齐 `0.2.1-rc.5` / `~4.0.5`），`devDependencies` 只放 `typescript`
- [X] T002 创建 `tsconfig.json`：`module/moduleResolution = NodeNext`、`target = ES2022`、`strict = true`、`outDir = dist`、`rootDir = src`、`declaration = true`、`verbatimModuleSyntax = true`
- [X] T003 [P] 创建 `scripts/link-host.sh`：把 `${DSH_INSTALL_DIR:-$HOME/.nvm/versions/node/v24.22.1/lib/node_modules/@deepseek-ai/dsh}/node_modules/@deepseek-ai` 链接到仓库 `node_modules/@deepseek-ai`；目标缺失时报错退出并打印如何覆盖路径
- [X] T004 [P] 创建 `src/index.ts` 占位骨架（导出 `name` / `inject` / `Config` / `apply` 四件套，`apply` 暂为空），确保 `npm run build` 从第 1 天起可用
- [X] T005 跑通并回填命令：实际执行 `npm run build`、`npm run test`、`npm run typecheck`，把真实结果与命令写入 `AGENTS.md` §构建与运行，替换其中的"尚未建立"

**Checkpoint**: 构建与测试链路可用，任何后续切片都能跑验证。

---

## Phase 2: Foundational（阻塞性前提）

**Purpose**: 所有用户故事共用的状态、配置、文案与插件骨架。**此阶段完成前不能开始任何故事。**

- [X] T006 [P] 实现配置 schema 于 `src/config.ts`：`enabled: boolean = true`、`stallNoticeThreshold: number = 5`；两者在 `apply` 中同步校验，非法值抛出（`stallNoticeThreshold` 必须是正安全整数），不得静默回退
- [X] T007 [P] 实现轮次状态于 `src/state.ts`：按顶层 agent 保存唯一 `TurnLatch { turn, state, repairs, noticeShown }`；轮次号变化即整体替换；提供 `get(agent, turn)`、`declare(agent, turn, state)`、`bumpRepair(...)`、`markNoticeShown(...)`、`forget(agent)`；默认 `state = 'working'`、`repairs = 0`、`noticeShown = false`
- [X] T008 [P] 编写文案于 `src/prompt.ts`：系统提示词章节文本（含 `done` / `awaiting_user` 语义与"未声明即视为未完成"的后果说明），以及 `repairText(reason, attempt)` 骨架，必须含非授权声明与三个出口（见 `contracts/notice.message.md`）
- [X] T009 声明消息来源于 `src/notices.ts`：通过 `MessageSourceMap` 模块扩展加入 `kind: 'target-monitor'`，并用 `createUserMessage` 构造 `{ kind, form: 'notice', summary }`；**禁止**使用 `'user'`
- [X] T010 实现插件入口于 `src/index.ts`（**替换 T004 的占位实现**）：`inject = ['agents', 'tools', 'systemPrompt']`；注册系统提示词章节（`order` 取 `ctx.systemPrompt.getSectionOrder(...)` 既有槽位之后）；启动时校验所需服务与事件，缺失则抛出明确错误（FR-015）
- [X] T011 [P] 写测试 `tests/unit/config.test.ts`：合法配置通过；`stallNoticeThreshold = 0` / 负数 / 非整数 / `enabled` 非布尔 → 抛出且错误信息含字段名

**Checkpoint**: 状态、配置、文案、来源、入口齐备；故事实现只需接线。

---

## Phase 3: User Story 1 - 未声明完成即收尾时自动续行（P1）🎯 MVP

**Goal**: 轮次在未声明目标状态时结束，插件自动要求继续，本轮不关闭。

**Independent Test**: 构造"不声明就收尾"的轮次，观察同一轮内出现 `[target-monitor]` 提醒且再走一步；声明 `done` 后正常关闭。

### Tests for User Story 1（先写、先失败）

- [X] T012 [P] [US1] 写 `tests/unit/state.test.ts`：新轮次默认 `working`；`declare` 后状态改变；轮次号 +1 后自动回到 `working` 且 `repairs` 归零
- [X] T013 [P] [US1] 写 `tests/unit/gate.test.ts`：未声明 + `finish.kind = 'stop'` → 产生一次 steer，`repairs` 由 0 变 1；已声明 `done` → 不 steer
- [X] T014 [P] [US1] **创建** `tests/unit/prompt.test.ts`：断言 `repairText` 含非授权声明（"not user approval"）、三个出口、以及 `awaiting_user` 的存在；断言长度 < 1.5 KB（`contracts/notice.message.md` 第 5 条）
- [X] T015 [P] [US1] 写 `tests/integration/turn-gate.test.ts`：假 agent 上跑完整收尾流程，断言 steer 被调用一次、消息来源为 `target-monitor`/`notice`

### Implementation for User Story 1

- [X] T016 [US1] 实现 `src/tool.ts`：`defineTool` 注册 `target_status`，参数 `state`（`'done' | 'awaiting_user'`，必填）与 `summary`（可选），输出 `{ ok, turn, state }`；非顶层 agent 返回 `TARGET_STATUS_NOT_ROOT`，非法枚举返回 `TARGET_STATUS_INVALID_STATE`（见 `contracts/target-status.tool.md`）
- [X] T017 [US1] 实现 `src/gate.ts`：`agent/turn-stopping` 处理器——非顶层 agent 直接返回；已声明直接返回；否则 `repairs += 1` 并注入提醒；注入前检查 `agent.inbox.nextStep`：为空用 `agent.steer(...)`，非空用 `agent.inbox.prepend('next-step', ...)` 保证提醒位于队首（FR-017）；监听器内异常就地捕获记录，不得外抛
- [X] T018 [US1] 在 `src/index.ts` 接线：注册 `target_status` 工具、订阅 `agent/turn-stopping` 与 `agent/disposed`，并在 dispose 时清理该 agent 闩锁
- [X] T019 [US1] 补 `tests/unit/gate.test.ts` 用例锁定 FR-014：助手正文含 `DONE` / `完成` / "task complete" 等字样但未调用 `target_status` → **仍然** steer；判定只读闩锁，不读消息文本
- [ ] T020 [US1] 端到端自测：按 `quickstart.md` S1 走查一次，记录实际观察结果到 `quickstart.md` 的"已知需要人工确认的点"表

**Checkpoint**: US1 可独立交付，此时已是可用 MVP。

---

## Phase 4: User Story 2 - 等待用户确认时不被打扰（P1）

**Goal**: 模型声明 `awaiting_user` 后收尾，插件零打扰。

**Independent Test**: 声明 `awaiting_user` 的轮次结束时，steer 调用次数为 0。

### Tests for User Story 2

- [X] T021 [P] [US2] 扩充 `tests/unit/gate.test.ts`：`awaiting_user` → 不 steer；同一轮内先声明 `done` 再声明 `awaiting_user` → 以最后一次为准
- [X] T022 [P] [US2] 扩充 `tests/unit/prompt.test.ts`：系统提示词章节与提醒文案都出现 `awaiting_user`，且提醒文案含"不解除确认要求"的句子

### Implementation for User Story 2

- [X] T023 [US2] 在 `src/gate.ts` 落实放行集合 `{ done, awaiting_user }`，并在 `src/state.ts` 落实"后声明覆盖前声明"语义
- [X] T024 [US2] 在 `src/prompt.ts` 补齐"等待用户"出口的措辞：明确说明若在等确认，应先声明再收尾，而不是继续执行

**Checkpoint**: US1 + US2 同时成立——既不放弃任务，也不越过用户确认。

---

## Phase 5: User Story 3 - 输出被截断时从中断处继续（P2）

**Goal**: 识别长度上限截断，提醒中说明"截断后工具未执行"。

**Independent Test**: `finish.kind = 'max-tokens'` 的轮次产生 `truncated` 文案且含工具未执行说明；`stop` 轮次不含该句。

### Tests for User Story 3

- [X] T025 [P] [US3] 写 `tests/unit/cause.test.ts`：`max-tokens → truncated`；`stop → undeclared`；`aborted`/`error` → 不产生提醒
- [X] T026 [P] [US3] 扩充 `tests/unit/prompt.test.ts`：`truncated` 文案含"tool calls after the cut were not executed"，`undeclared` 文案不含该句

### Implementation for User Story 3

- [X] T027 [US3] 实现 `src/cause.ts`：订阅 `agent/assistant-stream`，只在 `frame.chunk.type === 'finish'` 时记录该 agent 当前轮的最后 `reason.kind`；轮次变化时重置（与 `state.ts` 共用轮次键）
- [X] T028 [US3] 在 `src/prompt.ts` 增加 `truncated` 增量段落，并在 `src/gate.ts` 按 `StopCause` 选择文案
- [X] T029 [US3] 补齐降级：若 `agent/assistant-stream` 不可用，全部按 `undeclared` 处理并记录一次警告（见 `contracts/plugin.entry.md`）

**Checkpoint**: 截断场景不再被当成普通收尾，模型不会误以为工具已执行。

---

## Phase 6: User Story 4 - 卡住时告知用户（P2）

**Goal**: 达到阈值时向用户展示"可能卡住"，且只展示一次；同时锁定"不设上限"。

**Independent Test**: 同一轮连续达到阈值 → 出现一次用户提示；超过阈值后继续修复但不再提示。

### Tests for User Story 4

- [X] T030 [P] [US4] 扩充 `tests/unit/gate.test.ts`：`repairs` 达到阈值时消息附带用户提示且 `noticeShown` 置位；下一次不含该提示
- [X] T031 [P] [US4] 扩充 `tests/unit/config.test.ts`：`stallNoticeThreshold` 自定义为 2 时第 2 次即提示
- [X] T032 [P] [US4] 扩充 `tests/unit/gate.test.ts` 锁定 FR-009：同一轮连续 10 次未声明 → 每次都 steer；断言不存在任何"放弃/跳过/上限"分支（第 11 次仍产生提醒）

### Implementation for User Story 4

- [X] T033 [US4] 在 `src/notices.ts` 增加面向用户的提示段，并在 `src/gate.ts` 用 `noticeShown` 保证每轮最多一次
- [ ] T034 [US4] 按 `quickstart.md` S4 在真实界面确认提示可见（`form: 'notice'` 的渲染），把结果记入"已知需要人工确认的点"表

**Checkpoint**: 无上限策略有了人工介入点，且该策略被测试锁死。

---

## Phase 7: User Story 5 - 用户取消优先于插件判断（P3）

**Goal**: 取消后本轮不再提醒；下一轮自动恢复门控；插件绝不自行重试或重启。

**Independent Test**: 取消路径零提醒；下一次用户输入后门控照常。

### Tests for User Story 5

- [X] T035 [P] [US5] 扩充 `tests/unit/gate.test.ts`：`finish.kind = 'aborted'` → 不 steer；随后同一 agent 进入新轮次 → 未声明时照常提醒
- [X] T036 [P] [US5] 扩充 `tests/integration/turn-gate.test.ts` 锁定 FR-013：插件**不订阅** `agent/request-error`；`agent/error` 触发后不调用 `steer`/`followup`，不重启轮次

### Implementation for User Story 5

- [X] T037 [US5] 在 `src/gate.ts` 增加显式 `aborted` 防御分支（即使宿主不会在该路径派发收尾事件），并在 `src/state.ts` 保证新轮次重置

**Checkpoint**: 五个故事全部可独立验证。

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T038 [P] 在 `src/gate.ts` 落实"仅顶层 agent 设门"（`ctx.agents.roots()`）并补 `tests/unit/gate.test.ts` 用例：子 agent 收尾零提醒（SC-005）
- [X] T039 [P] 补 `tests/unit/prompt.test.ts` 反例断言：文案不含任何外部文本占位、长度符合契约（< 1.5 KB）、必须含三个出口（FR-007/FR-016）
- [X] T040 补宿主契约自检与失败测试：缺 `tools` / `systemPrompt` 服务时抛错并停用（FR-015、SC-006）
- [ ] T041 [UNCERTAIN] 实测 `concludesTurn` 轮次语义（用 `present` 触发），决定是否豁免；结论写入 `research.md` 的未决项表
- [ ] T042 [UNCERTAIN] 实测轮次内 goal 转 `complete`/`blocked` 的事件时序；若不可靠，按"最多多催一次"处理并记录（与 spec.md 边界条目一致）
- [ ] T043 跑 `quickstart.md` 全部 6 个构造场景（S1–S6）**外加 3 个不同类型的真实任务**（SC-007），把结果填进该文件的验证表
- [X] T044 按五轴审查（正确性/可读性/架构/安全/性能），安全轴必须覆盖：来源不得为 `user`、文案不得拼接外部文本、取消不复活、注入不破坏前缀缓存
- [X] T045 [P] 更新 `AGENTS.md` §宿主事实速查（补 `concludesTurn`、notice 渲染的实测结论）与 `README.md`（当前仍写着"尚无实现代码"）
- [X] T046 补 FR-017 顺序用例于 `tests/unit/gate.test.ts`：`nextStep` 为空 → 走 `steer`；`nextStep` 已有消息 → 走 `prepend` 且提醒位于索引 0；并断言两种路径下排队消息相对顺序不变

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**：无依赖，可立即开始
- **Foundational (Phase 2)**：依赖 Setup，**阻塞全部故事**
- **User Stories (Phase 3–7)**：均依赖 Foundational；US1 是先决（其余故事复用其 `gate.ts` / `notices.ts` 骨架）
- **Polish (Phase 8)**：依赖所选故事完成

### User Story Dependencies

- **US1（P1）**：Foundational 后即可，无故事依赖 —— 这是 MVP
- **US2（P1）**：复用 US1 的 `gate.ts`，可独立测试（断言"不 steer"）
- **US3（P2）**：复用 US1，新增 `cause.ts` 与文案分支
- **US4（P2）**：复用 US1 的 `notices.ts`，新增阈值与"无上限"锁定
- **US5（P3）**：复用 US1 的 `gate.ts`，新增防御分支与"不重试"锁定

### 同文件冲突（必须串行）

| 文件 | 涉及任务 | 建议顺序 |
|---|---|---|
| `tests/unit/gate.test.ts` | T013 → T019 → T021 → T030 → T032 → T035 → T038 → T046 | 按编号顺序 |
| `tests/unit/prompt.test.ts` | T014（创建）→ T022 → T026 → T039 | 按编号顺序 |
| `tests/unit/config.test.ts` | T011（创建）→ T031 | 按编号顺序 |
| `tests/integration/turn-gate.test.ts` | T015（创建）→ T036 | 按编号顺序 |
| `src/index.ts` | T004（占位）→ T010 → T018 | 按编号顺序 |

### Parallel Opportunities

- T003 / T004 并行（不同文件）
- T006 / T007 / T008 / T011 并行（不同文件）
- T012 / T013 / T014 / T015 并行（四个不同测试文件，互不冲突）
- T025 / T026 并行（不同文件）
- T038 / T039 / T045 并行（不同文件）

---

## Parallel Example: User Story 1

```bash
# 四个测试文件互不冲突，可同时开始
Task: "写 tests/unit/state.test.ts（T012）"
Task: "写 tests/unit/gate.test.ts（T013）"
Task: "创建 tests/unit/prompt.test.ts（T014）"
Task: "写 tests/integration/turn-gate.test.ts（T015）"

# 测试全红之后，再依次实现
Task: "实现 src/tool.ts（T016）"
Task: "实现 src/gate.ts（T017）"
Task: "接线 src/index.ts（T018）"
```

---

## Implementation Strategy

### MVP First（仅 US1）

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1
4. **STOP & VALIDATE**：按 quickstart S1 走查
5. 此时已能阻止"做一半就收尾"，具备独立交付价值

### Incremental Delivery

1. Setup + Foundational → 地基就绪
2. US1 → 验证 → 可用 MVP
3. US2 → 验证（不误伤提问）→ 交付
4. US3 → 验证（截断说明）→ 交付
5. US4 → 验证（阈值提示 + 无上限锁定）→ 交付
6. US5 → 验证（取消语义 + 不重试锁定）→ 交付
7. Polish → 审查与文档回填

### 提交节奏

每个 Phase 结束提交一次；US1 内部可按"测试红 → 实现绿"分两次提交，但不把测试与实现拆到不同 phase。

---

## Notes

- [P] 任务 = 不同文件且无未完成依赖
- 测试必须先写并确认失败，再写实现（宪法 II）
- 每个 Checkpoint 都可停下来独立验收
- 遇到宿主行为与文档不符时，以实测为准并回写 `research.md` 与 `AGENTS.md`
- 三条 MUST NOT（FR-009 / FR-013 / FR-014）各由一个专门用例锁定，回归时不得删除
