# Tasks: 可观测性与可分发

**Feature**: 004-observability-and-packaging · **Input**: plan.md / spec.md / data-model.md / contracts/

## Phase 1: Setup

- [x] T001 确认三块改动面互不耦合：留痕（`src/trace.ts`）、设置页（`config.ts` 的 volatile 字段）、打包（`package.json` + `dsh.bundle.patch`）

## Phase 2: Foundational（留痕是另外两块的前置观测手段）

- [x] T002 [P] 新建 `tests/unit/trace.test.ts`：字段集合、短哈希、缓冲上限、写入失败不抛、轮转（先红）
- [x] T003 新建 `src/trace.ts`：`GateTraceEntry` / `recordTrace` / `recentTraces` / `configureTrace` / `resetTraceState`
- [x] T004 在 `src/trace.ts` 用 `sha256` 前 8 位做会话标识，绝不落 agent 原始 id
- [x] T005 在 `src/trace.ts` 实现覆盖式轮转：超 `maxBytes` 时改名为 `.1`，只保留两代

## Phase 3: US1（P1）— 每次判定留一条痕

- [x] T006 [US1] 在 `src/gate.ts` 的 `GateDeps` 增加可选 `trace?(agent, entry)`
- [x] T007 [US1] 在 `src/gate.ts` 把五个提前返回改为 `released(reason)`，注入分支报 `injected/undeclared`
- [x] T008 [US1] 在 `src/gate.ts` 区分 `aborted` 与 `error`（读原始 `FinishReason.kind`，不靠 `classify` 的归一化结果）
- [x] T009 [P] [US1] 在 `tests/unit/gate.test.ts` 补六种出口的留痕用例
- [x] T010 [US1] 在 `src/index.ts` 接线 `trace → recordTrace`，并在 `apply` 时 `configureTrace({})`

## Phase 4: US2（P2）— 设置页

- [x] T011 [US2] 在 `src/config.ts` 把 `reminderThreshold` / `reactionWindowMs` 声明为 `.volatile()`
- [x] T012 [US2] 在 `src/config.ts` 用 `assertVolatilePositiveInt` 覆盖已解析路径，非法值即时抛出并带字段名
- [x] T013 [US2] 在 `src/config.ts` 原始路径逐个复核三个阈值（`z.number()` 放行 0，schema 不是边界）
- [x] T014 [US2] 确认插件不依赖设置服务：`engine` 无 `inject: ['settings']`，设置服务缺席时照常工作

## Phase 5: US3（P3）— 可分发

- [x] T015 [US3] `package.json` 移除 `private`，补 `repository` / `homepage` / `keywords`
- [x] T016 [US3] `package.json` 补 `dsh.manifestVersion: 1` 与 `dsh.bundle.patch`，`engines.dsh` 声明兼容范围
- [x] T017 [US3] `files` 收敛为 `dist` / `dsh.bundle.patch` / `README.md`
- [x] T018 [P] [US3] 新建 `dsh.bundle.patch`：只做 insert，不改宿主既有条目
- [x] T019 [P] [US3] 新建 `tests/unit/manifest.test.ts`：私有标记、清单版本、补丁存在性与顶层键、engines、peer 依赖、入口指向 `dist`

## Phase 6: Polish

- [x] T020 测试进程内默认不落盘（`NODE_TEST_CONTEXT`），并补断言防止回归
- [x] T021 清理被测试污染的 `~/.dsh/logs/target-monitor/`（66 条假记录）
- [x] T022 更新 `README.md`：安装三法、设置页字段表、留痕用法与检索命令
- [x] T023 更新 `AGENTS.md`：目录结构、实测状态、发布信息
- [x] T024 全量回归：`npm test` 96 项、`npm run typecheck`、`npm run build`、`npm pack --dry-run` 内容核对

## 未完成（需要用户决定或外部条件）

- [ ] T025 市场清单 format 1 的发布流程（`MarketPlugin` / `MarketVersion` 生成）——本地只保证源字段齐备
- [ ] T026 首次 `npm publish` 与 git tag：需确认 npm 账号与包名占用情况

## 判据

- 某轮在 `gate-trace.jsonl` 里查不到记录，才说明该轮未被判定。
- 记录不得出现在对话消息、系统提示词或任何工具返回值中。
- 磁盘写满时判定照常进行，仅告警一次。
- `npm pack` 产物不含 `src/` 与 `tests/`。
