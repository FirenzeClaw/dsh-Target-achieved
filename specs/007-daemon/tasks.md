---

description: "Task list for 跨进程监测守护"
---

# Tasks: 跨进程监测守护

**Input**: Design documents from `/specs/007-daemon/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/ipc-protocol.md](./contracts/ipc-protocol.md)

**Tests**: 宪法原则 II 要求测试先行——每个实现任务前必须有失败的测试（RED → GREEN）。

**Organization**: 按 User Story 分组。US1 的测试**手工 spawn 守护进程**，不依赖 US2 的自动拉起；US2 只验生命周期；US3 只验降级。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1 / US2 / US3）
- 每条都带精确文件路径

## Path Conventions

单项目：`src/`、`tests/` 在仓库根；测试用 `node --test`。

---

## Phase 1: Setup

**Purpose**: 建立模块骨架，不写业务逻辑

- [x] T001 创建 `src/ipc/`、`src/daemon/`、`src/monitor/` 三个目录与空模块文件（`protocol.ts`、`client.ts`、`launcher.ts`、`main.ts`、`server.ts`、`state.ts`、`types.ts`、`local.ts`、`remote.ts`），每个文件只写模块级 JSDoc
- [x] T002 [P] 创建测试骨架 `tests/unit/ipc-protocol.test.ts`、`tests/unit/daemon-state.test.ts`、`tests/unit/launcher.test.ts`、`tests/integration/daemon-lifecycle.test.ts`、`tests/integration/daemon-degrade.test.ts`、`tests/integration/daemon-multiprocess.test.ts`、`tests/contract/monitor-parity.test.ts`，确认 `npm test` 能发现它们且既有 98 项仍全绿

---

## Phase 2: Foundational（阻塞所有用户故事）

**Purpose**: 协议类型、编解码与 `Monitor` 接口是三个故事共用的地基

**⚠️ 必须先完成本阶段**

### 测试

- [x] T003 [P] 在 `tests/unit/ipc-protocol.test.ts` 写用例：编码为单行 JSON（含换行时不得出现在字符串内）；解码拒绝非 JSON、拒绝超 64 KiB；`turn` 非负整数校验；未知 `type` 返回 `E_BAD_REQUEST`——先看它失败
- [x] T004 [P] 在 `tests/unit/ipc-protocol.test.ts` 写用例：`hello` 的 `protocol` 不等于当前值时产出 `fatal`（C-001）；`requestId` 格式非法时拒绝（C-007 前置）——先看它失败
- [ ] T005 [P] 在 `src/monitor/types.ts` 定义 `Monitor` 接口的契约测试：`turnStart` / `declare` / `turnStopping` / `upstreamError` / `resumeConfirm` / `finish` / `dispose` 七个方法，返回值类型与 `contracts/ipc-protocol.md` 的 `data` 表逐字段一致——先看它失败

### 实现

- [x] T006 在 `src/ipc/protocol.ts` 实现 `encodeMessage` / `decodeMessage` / `validateRequest`：编解码、64 KiB 上限、字段校验、错误码常量（`E_BAD_REQUEST`/`E_UNKNOWN_SESSION`/`E_OVERSIZE`/`E_INTERNAL`）
- [x] T007 [P] 在 `src/monitor/types.ts` 定义 `Monitor` 接口、`MonitorRequest`/`MonitorResponse` 联合类型、`MonitorConfigSnapshot`（七个字段）与 `TraceRecord`（含可选 `degraded`）
- [x] T008 在 `src/config.ts` 新增 `daemonMode`（`'auto' | 'off'`，默认 `'auto'`，`.volatile()`），并在 `snapshot()` 中暴露；`'off'` 对应 FR-016 的强制进程内模式

---

## Phase 3: User Story 1 - 多实例共享同一份判定 (P1) 🎯 MVP

**Goal**: 守护进程持有状态并对外提供判定；两个客户端连同一守护进程时计数共享、留痕单写。

**Independent Test**: 手工 spawn 一个守护进程（用测试夹具，不经拉拉起逻辑），两个客户端交替发 `turn-stopping`，断言第 3 次 `reminder` 为真；并发 200 次后留痕全部可解析。

### 测试

- [x] T009 [P] [US1] 在 `tests/unit/daemon-state.test.ts` 写状态转移用例：`turn-start` 重置声明；窗口内 `declare` 使 `forgetCount + 1`；窗口外不计数（005 语义）；`finish: stop` 清零续行计数；`finish: error` 不清零——先看它失败
- [x] T010 [P] [US1] 在 `tests/unit/daemon-state.test.ts` 写隔离用例：不同 `sessionId` 互不影响；同一 `sessionId` 跨连接可见（FR-007）——先看它失败
- [x] T011 [P] [US1] 在 `tests/integration/daemon-multiprocess.test.ts` 写用例：夹具 spawn 守护进程 → 两个独立客户端连接 → 交替触发未声明收尾 → 第 3 次 `reminder === true`（SC-001）——先看它失败
- [x] T012 [P] [US1] 在 `tests/integration/daemon-multiprocess.test.ts` 写用例：200 次并发判定后读取 JSONL，全部可按行解析（SC-004）——先看它失败

### 实现

- [x] T013 [US1] 在 `src/daemon/state.ts` 实现 `MonitorState` 表与七个转移函数，键为 `sessionId`；`declare` 的窗口判定复用 `src/forget.ts` 的既有语义（迁移不改行为）
- [x] T014 [US1] 在 `src/daemon/server.ts` 实现请求分发、`(sessionId, turn, type)` 幂等缓存（上限 256，C-008）、单请求异常隔离返回 `E_INTERNAL`（FR-013）
- [x] T015 [US1] 在 `src/daemon/main.ts` 实现进程入口：解析 `--socket`/`--pid` 参数、`net.createServer`、逐行解码、接线 `server.handle`
- [x] T016 [US1] 在 `src/monitor/remote.ts` 实现 `RemoteMonitor`：连接、握手、请求/响应关联、未握手前拒绝发请求
- [x] T017 [US1] 把 `src/trace.ts` 的写入路径改为可注入 sink：`LocalMonitor` 直接写文件，`RemoteMonitor` 由守护进程写；`degraded` 字段只在本地写时置真（FR-011）
- [ ] T018 [US1] 在 `tests/contract/monitor-parity.test.ts` 写双向一致性用例并跑通：同一组操作序列分别驱动 `LocalMonitor` 与 `RemoteMonitor`，断言七个方法的返回值逐字段相同

---

## Phase 4: User Story 2 - 生命周期跟随 DSH (P2)

**Goal**: 首个客户端拉起守护进程；最后一个离开后 30 秒退出；陈旧 socket 自愈。

**Independent Test**: 在临时 `DSH_HOME` 下走完整生命周期（拉起 → 双连接 → 逐个断开 → 31 秒后检查进程与文件）；再强杀一次验证自愈。

### 测试

- [x] T019 [P] [US2] 在 `tests/unit/launcher.test.ts` 写用例：`ECONNREFUSED` 且 pid 已死 → 判定为陈旧 → 清理；`ECONNREFUSED` 但 pid 存活 → 不清理（R-004 的竞态防护）——先看它失败
- [x] T020 [P] [US2] 在 `tests/integration/daemon-lifecycle.test.ts` 写用例：无守护进程时首个请求触发拉起，5 秒内返回（SC-006 的前半）——先看它失败
- [x] T021 [P] [US2] 同上文件写用例：两个连接先后断开，最后一个断开后 30 秒守护进程退出，`run/` 下无残留（SC-002）——先看它失败
- [x] T022 [P] [US2] 同上文件写用例：`kill -9` 保留 socket → 下次请求能自愈并在 5 秒内成功（SC-006）——先看它失败

### 实现

- [x] T023 [US2] 在 `src/ipc/launcher.ts` 实现 `ensureDaemon(socketPath)`：`ensureDir`、陈旧检测（`error.code` 分流 + `process.kill(pid, 0)` 二次确认）、`spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' }).unref()`、50 毫秒 × 100 次重试
- [x] T024 [US2] 在 `src/daemon/main.ts` 实现连接计数与宽限退出：归零启动 `setTimeout(30_000).unref()`，新连接取消；退出前 `unlink` socket 与 pid
- [x] T025 [US2] 在 `src/daemon/main.ts` 写入 pid 文件（启动时）与 `SIGTERM`/`SIGINT` 清理（退出时）
- [x] T026 [US2] 在 `src/ipc/client.ts` 实现 `connect()`：建立连接 → 发 `hello` → 等 `welcome`；`fatal` 时抛 `ProtocolMismatchError` 并置本进程不再尝试（C-013）
- [x] T027 [US2] 在 `package.json` 的 `files` 与构建产物中确认 `dist/daemon/main.js` 随包分发，并加一条 manifest 测试断言该文件存在

---

## Phase 5: User Story 3 - 守护进程不可用时功能不丢 (P3)

**Goal**: RPC 失败或超时 200 毫秒时，本进程改用 `LocalMonitor`，功能与引入前一致，只告警一次。

**Independent Test**: 把 `DSH_HOME` 指向不可写路径，观察收尾判定仍能注入、留痕仍写入且带 `degraded` 标记、stderr 只有一条告警。

### 测试

- [x] T028 [P] [US3] 在 `tests/integration/daemon-degrade.test.ts` 写用例：socket 路径不可写 → 首个请求降级 → `turn-stopping` 仍返回 `inject: true`（SC-003）——先看它失败
- [x] T029 [P] [US3] 同上文件写用例：降级后连续 10 次判定，告警只出现 1 次（FR-018）——先看它失败
- [x] T030 [P] [US3] 同上文件写用例：降级期间留痕带 `degraded: true`，且不写守护进程路径之外的第二个文件（FR-011）——先看它失败
- [x] T031 [P] [US3] 同上文件写用例：模拟守护进程挂起（不响应），单次判定耗时 ≤ 200 毫秒（SC-005）——先看它失败

### 实现

- [x] T032 [US3] 在 `src/monitor/remote.ts` 实现 200 毫秒超时与降级切换：超时/连接失败 → 切 `LocalMonitor` → 记一次告警 → 本进程后续请求不再尝试
- [x] T033 [US3] 在 `src/monitor/local.ts` 实现 `LocalMonitor`：包装既有 `state`/`forget`/`resume`/`turn`/`trace`，语义与今天逐字一致（parity 测试即为此处的回归网）
- [x] T034 [US3] 在 `src/index.ts` 接线：`apply` 时选择 monitor；`turn-stopping` 改为 `async` 并 `await` 判定（R-008），超时分支走同步本地兜底；其余事件照旧转发
- [x] T035 [US3] 在 `src/index.ts` 处理 `daemonMode === 'off'`：跳过远程，直接用 `LocalMonitor`（FR-016）

---

## Phase 6: Polish & Cross-Cutting

- [x] T036 [P] 更新 `docs/PLUGIN-DESIGN.md`：新增「为什么引入守护进程」「为什么保留双实现」「协议版本为何必要」三节，附 `contracts/ipc-protocol.md` 链接
- [x] T037 [P] 更新 `README.md`：安装后行为变化、`daemonMode` 配置项、故障排查（如何看 `run/` 下的文件、如何强制进程内模式）
- [x] T038 [P] 更新 `AGENTS.md`：目录结构加三个新目录，构建与运行补守护进程的验证命令，测试计数更新
- [x] T039 [P] 更新 `CHANGELOG.md` 的 `[Unreleased]`，并在 `package.json` 升到 `0.3.0`
- [x] T040 全量验证：`npm run typecheck && npm run build && npm test` 全绿；`npm pack` 后确认 `dist/daemon/main.js` 在包内；按 `quickstart.md` 跑完七个场景

---

## Dependencies

```
T001–T008（地基）
   ├─→ Phase 3 (US1)：T009–T018 —— 可独立交付的最小可用切片
   ├─→ Phase 4 (US2)：T019–T027 —— 依赖 T013/T015（守护进程本体）
   └─→ Phase 5 (US3)：T028–T035 —— 依赖 T016（RemoteMonitor 存在）
Phase 6：T036–T040 —— 依赖前三阶段
```

**US1 → US2 → US3** 是推荐顺序：US1 建立状态权威，US2 补生命周期，US3 补失败路径。反过来做会让 US3 没有可降级的目标。

## Parallel Execution

- Phase 2：T003/T004/T005 三个测试文件互不干扰，可并行写
- Phase 3：T009/T010 同文件（顺序），T011/T012 同文件（顺序），两组可并行
- Phase 4：T019 独立文件；T020–T022 同文件顺序
- Phase 6：T036–T039 四个文档互不干扰，可并行

## Implementation Strategy

**MVP = Phase 3（US1）**：守护进程能跑、两个客户端能共享计数、留痕单写。此时 US2 的自动拉起还没做，需要手工启动守护进程——但对「计数共享」这个核心价值已经可演示。

**风险最高的一步是 T034**（把 `turn-stopping` 改成 async 并接线 monitor）。既有 98 项测试全部依赖同步注入的假设，改完必须立刻跑全量测试；若出现「注入丢失」，优先怀疑监听器返回时机而不是守护进程。
