---

description: "Task list for 上游异常自动续行"
---

# Tasks: 上游异常自动续行

**Input**: Design documents from `/specs/006-upstream-resume/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)

**Tests**: 本项目宪法原则 II 要求测试先行，所有实现任务前必须有失败的测试（RED → GREEN）。

**Organization**: 按 User Story 分组，每个故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1 / US2 / US3）
- 每条都带精确文件路径

## Path Conventions

单项目：`src/`、`tests/` 在仓库根。

---

## Phase 1: Setup

**Purpose**: 建立新模块与测试文件骨架，不写业务逻辑

- [ ] T001 创建 `src/resume.ts` 骨架：导出 `ResumeState` 类型与 `RETRYABLE_CODES` 常量（`['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`，须与 `dsh-llm/lib/types/retry-policy.js:16-22` 逐项一致），函数体留空
- [ ] T002 [P] 创建 `tests/unit/resume.test.ts` 与 `tests/integration/upstream-resume.test.ts` 骨架，确认 `npm test` 能发现并跳过空文件

---

## Phase 2: Foundational（阻塞所有用户故事）

**Purpose**: 配置项与留痕类型是三个故事共用的地基

**⚠️ 必须先完成本阶段**

### 测试

- [ ] T003 [P] 在 `tests/unit/config.test.ts` 追加用例：`maxResumes` 接受 `0`（关闭语义）、拒绝负数；`resumeOnUpstreamError` 接受布尔、拒绝字符串；已解析路径（volatile 引用对象）同样复核；**并断言两者都是 volatile 引用对象**（`typeof value.get === 'function'`），这是设置页能自动生成表单的前提（FR-016）——先看它失败
- [ ] T004 [P] 在 `tests/unit/trace.test.ts` 追加用例：三个新 `reason` 可写入；`errorCode` 可选（缺省时不出现该键）；既有六字段序列化结果不变——先看它失败

### 实现

- [ ] T005 在 `src/config.ts` 新增 `resumeOnUpstreamError`（`boolean`，默认 `true`）与 `maxResumes`（正整数，默认 `3`），二者均 `.volatile()`；`snapshot()` 带上二者；原始路径与已解析路径都做校验（`maxResumes >= 0`，负数抛错）
- [ ] T006 [P] 在 `src/trace.ts` 的 `GateReason` 追加 `'upstream-resumed' | 'upstream-skipped' | 'upstream-capped'`；`GateTraceEntry` 与 `TraceInput` 增加可选 `errorCode?: string`，序列化时缺省不写该键

**Checkpoint**: `npm test` 中 T003/T004 由红转绿，其余既有用例不受影响

---

## Phase 3: User Story 1 - 上游瞬时故障后自动接上 (Priority: P1) 🎯 MVP

**Goal**: 可重试错误导致轮次结束后，无需用户操作即自动续一轮

**Independent Test**: 假 agent 上触发一次 `RATE_LIMIT`，断言轮次 idle 后 `steer` 被调用一次，且消息正文等于 `repairText('undeclared', 1)`

### 测试

- [ ] T007 [US1] 在 `tests/unit/resume.test.ts` 写分类矩阵：5 个可重试码逐个返回可续行；`AUTH` / `QUOTA` / `ACCOUNT_QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `UNKNOWN` 逐个不可续行；非 `LlmError`（普通 `Error`、`AggregateError`）不可续行——先看它失败
- [ ] T008 [P] [US1] 在 `tests/unit/resume.test.ts` 写计数语义：首次 `noteResume` 后 `consecutive === 1`；同轮重复 `agent/error` 不累加；`resetResume` 归零——先看它失败
- [ ] T009 [US1] 在 `tests/integration/upstream-resume.test.ts` 驱动真实 `apply`：假 ctx 捕获 `agent/error` 监听器，假 agent 提供 `whenIdle()`（立即兑现）与 `steer`，断言 `steer` 收到 1 条消息、正文 `=== repairText('undeclared', 1)`、`createNotice` 的来源标记存在、同步阶段（`whenIdle` 之前）未发生投递——先看它失败
- [ ] T010 [US1] 在 `tests/integration/upstream-resume.test.ts` 追加：模拟一帧正常 `finish`（`stop`）后 `consecutive === 0`；模拟 `error` 帧则不清零（FR-011）——先看它失败

### 实现

- [ ] T011 [US1] 在 `src/resume.ts` 实现 `classifyUpstreamError(error: unknown): 'retryable' | 'non-retryable'`：用 `instanceof LlmError` + `RETRYABLE_CODES.has(error.code)`，不解析 message（C-002）
- [ ] T012 [US1] 在 `src/resume.ts` 实现 `noteResume(agent, turn)` / `resetResume(agent)` / `forgetResume(agent)`，用 `WeakMap<Agent, ResumeState>`；`noteResume` 同轮幂等（`lastTurn === turn` 时不动）
- [ ] T013 [US1] 在 `src/index.ts` 注册 `ctx.on('agent/error', ...)`：分类 → `noteResume` → `agent.whenIdle().then(...)`；兑现后复核前置条件再 `agent.steer(createNotice(repairText('undeclared', 1), summary))`（C-004 / C-005 / C-006）
- [ ] T014 [US1] 在 `src/index.ts` 的 `agent/assistant-stream` finish 帧分支调用 `resetResume(agent)`（C-007）
- [ ] T015 [US1] 反向验证：临时把 `whenIdle()` 换成同步投递，确认 T009 至少一条用例失败，随后还原并记录结果

**Checkpoint**: T007–T010 全绿；MVP 可用

---

## Phase 4: User Story 2 - 不可恢复的错误与取消不空转 (Priority: P2)

**Goal**: 注定失败的错误与用户取消绝不触发续行；插件自身异常不得打断对话

**Independent Test**: 注入 `AUTH`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`，三者 `steer` 调用次数均为 0

### 测试

- [ ] T016 [P] [US2] 在 `tests/integration/upstream-resume.test.ts` 追加：`AUTH` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` 时 `steer` 不被调用；`enabled: false` 与 `resumeOnUpstreamError: false` 时同样不调用；非 root agent 不调用——先看它失败
- [ ] T017 [P] [US2] 在 `tests/unit/resume.test.ts` 追加 `shouldResume` 的前置条件矩阵（六项逐项为假时返回 false 并给出跳过原因）。**取消一项按防御性编写**：直接调用判定函数，不伪装成端到端（取消路径不派发 `agent/error`，见 spec FR-005 实现说明）
- [ ] T018 [US2] 在 `tests/integration/upstream-resume.test.ts` 追加异常隔离用例：让 `whenIdle()` 返回一个 reject 的 Promise、再让 `steer` 抛错，断言两处异常都被吞掉、`agent/error` 的后续传播不受影响（FR-017 / C-009）——先看它失败

### 实现

- [ ] T019 [US2] 在 `src/resume.ts` 实现 `shouldResume(agent, turn, config, isRoot): { resume: true } | { resume: false; reason: 'upstream-skipped' | 'upstream-capped' }`，覆盖 C-003 六项前置条件
- [ ] T020 [US2] 在 `src/index.ts` 的监听器与 `whenIdle` 回调中都用 `shouldResume` 复核，跳过时写留痕 `upstream-skipped`
- [ ] T021 [US2] 在 `src/index.ts` 的监听器入口与 `whenIdle` 回调内各加一层 `try/catch`，就地 `console.warn`（带轮次与错误码），确保任何异常都不外溢（FR-017）

**Checkpoint**: T016/T017/T018 全绿；US1 仍独立可用

---

## Phase 5: User Story 3 - 连续失败有上限，留痕可查 (Priority: P3)

**Goal**: 连续续行 3 次后停手，每次判断都能从留痕还原

**Independent Test**: 连续注入 4 次 `RATE_LIMIT`，前 3 次 `steer`、第 4 次不调用；留痕含 3 条 `upstream-resumed` + 1 条 `upstream-capped`

### 测试

- [ ] T022 [P] [US3] 在 `tests/integration/upstream-resume.test.ts` 追加：4 次连续 `RATE_LIMIT` → 投递 3 次；第 4 次不投递且留痕 reason 为 `upstream-capped`。**每次必须使用递增的 turn 号（1→4）**，否则会被 T012 的同轮幂等挡住、测试会假失败——先看它失败
- [ ] T023 [P] [US3] 在 `tests/unit/trace.test.ts` 追加：`upstream-resumed` 记录带 `errorCode`；`upstream-capped` 记录带 `errorCode`；用等价于 `jq` 的过滤（按 `outcome` / 既有 `reason`）时新记录不被误命中
- [ ] T024 [US3] 在 `tests/unit/resume.test.ts` 追加 dispose 用例：`forgetResume(agent)` 后 `consecutive` 归零、条目被删除；随后 `shouldResume` 返回可续行（证明没有残留脏状态）（FR-018）——先看它失败

### 实现

- [ ] T025 [US3] 在 `src/index.ts` 接入上限判断：`shouldResume` 返回 `upstream-capped` 时只留痕、不投递、不给用户额外提示（C-008）
- [ ] T026 [US3] 在 `src/index.ts` 的投递路径与跳过路径统一写留痕，带上 `errorCode`（非 `LlmError` 时写 `'UNKNOWN'`）
- [ ] T027 [US3] 在 `src/index.ts` 注册 `ctx.on('agent/disposed', ...)` → `forgetResume(agent)`，与既有 `forgetForgetful` 并列（FR-018）

**Checkpoint**: 三个故事全部独立可用

---

## Phase 6: Polish & 跨故事收尾

- [ ] T028 [P] 在 `docs/PLUGIN-DESIGN.md` 追加「错误路径与轮次级恢复」一节，记录为何不碰 `agent/request-error`、为何用 `steer` 而非 `followup`、为何取消判断只是防御
- [ ] T029 [P] 更新 `README.md`「覆盖边界」表：上游断流/限流从「部分覆盖」改为「已覆盖：重试耗尽后自动续行一轮，上限 3 次」；「开销」节补一句续行代价（一整轮上下文）；`AGENTS.md`「对外声明」第 6 条同步改写
- [ ] T030 [P] 在 `CHANGELOG.md` 写入新增内容（自动续行、两个配置项、三个 reason、可选 errorCode）与变更（上游断流覆盖范围）
- [ ] T031 升版本到 `0.2.0`（新特性，语义化次版本）：改 `package.json` 的 `version`、把 CHANGELOG 的 `[Unreleased]` 落成 `## [0.2.0] - <日期>`、打 annotated tag `v0.2.0`——`tests/unit/manifest.test.ts` 会校验版本必须在 CHANGELOG 中有对应条目
- [ ] T032 跑 `npm run typecheck && npm test && npm run build`，并按 `quickstart.md` 第 2–4 节做真实验证；把反向验证（T015）结论写进提交正文

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖
- **Foundational (Phase 2)**: 依赖 Setup；**阻塞所有用户故事**
- **US1 (Phase 3)**: 依赖 Phase 2
- **US2 (Phase 4)**: 依赖 Phase 2；实现上复用 US1 的监听器，测试独立
- **US3 (Phase 5)**: 依赖 Phase 2 与 US1 的投递路径
- **Polish (Phase 6)**: 依赖三个故事完成

### Within Each Story

- 测试先写并确认失败 → 实现 → 转绿
- `src/resume.ts` 内的函数按依赖顺序：分类 → 计数 → 前置条件

### Parallel Opportunities

- T002 / T003 / T004 可并行（不同测试文件）
- T005 与 T006 可并行（`config.ts` 与 `trace.ts` 互不相干）
- T007 与 T008 可并行（同文件不同 describe，提交时合并）
- T016 / T017 / T018 可并行（不同层次）
- T022 / T023 / T024 可并行
- T028 / T029 / T030 可并行（不同文档）

---

## Parallel Example: Phase 2

```bash
# 两个测试文件互不相干，可同时开工
Task: "在 tests/unit/config.test.ts 追加 maxResumes / resumeOnUpstreamError 校验用例（含 volatile 断言）"
Task: "在 tests/unit/trace.test.ts 追加新 reason 与 errorCode 用例"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 → Phase 2 → Phase 3
2. **STOP**：跑 T009 与 T015，确认可重试错误后确实自动续一轮、且去掉 idle 等待会失败
3. 此时上游断流已不再静默停机，可作为 0.2.0 的最小可交付

### Incremental Delivery

1. Setup + Foundational → 地基就绪（配置与留痕可用，但无行为变化）
2. US1 → 自动续行生效
3. US2 → 安全边界补齐（不该续行的情形全部挡住，自身异常不外溢）
4. US3 → 上限、留痕与 dispose 清理补齐
5. Polish → 文档、版本与发布收尾

---

## Notes

- [P] 表示不同文件、无未完成依赖
- 每个故事独立可测；US2/US3 的测试不依赖 US1 的实现细节
- 触碰轮次边界与注入面，提交前必须过安全轴（宪法原则 V）
- 严禁在 `agent/error` 监听器内同步投递（C-004），这是本特性最容易写错的地方
- 取消路径不派发 `agent/error`，相关断言只能是防御性的（spec FR-005 实现说明）
