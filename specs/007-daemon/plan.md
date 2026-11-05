# Implementation Plan: 跨进程监测守护

**Branch**: `007-daemon` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-daemon/spec.md`

## Summary

把判定状态（遗忘计数、续行计数、轮次声明、留痕写入）从「每个 DSH 进程各一份」搬到一个独立的守护进程，通过 unix socket 提供 NDJSON 协议的请求/响应。DSH 侧插件改造为瘦客户端：保留现有事件接线与注入动作，把「判定」换成一次 RPC；RPC 不可用时退回现有进程内实现，行为与今天完全一致。

技术要点：传输用 `node:net` 的 unix socket；拉起用 `spawn(..., { detached: true, stdio: 'ignore' }).unref()`；生命周期用连接计数 + 30 秒宽限；留痕由守护进程单写，天然无交错。

## Technical Context

**Language/Version**: TypeScript 5.9.3（`NodeNext`，ESM），运行时 Node v24.22.1

**Primary Dependencies**: 仅 Node 内置模块（`node:net`、`node:child_process`、`node:fs`、`node:path`、`node:crypto`、`node:os`）；宿主侧 peer 依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`

**Storage**: 留痕 JSONL（`$DSH_HOME/logs/target-monitor/gate-trace.jsonl`，沿用 004）；socket 与 pid 文件在 `$DSH_HOME/run/`

**Testing**: `node --test`（Node 24 原生类型剥离），分 `tests/unit`、`tests/integration`、`tests/contract` 三层

**Target Platform**: Linux / macOS 桌面（unix domain socket）

**Project Type**: 单包 npm 插件（library），附带一个随包分发的后台可执行脚本

**Performance Goals**: 单次 RPC p95 < 5 毫秒（本机 socket）；收尾判定超时预算 200 毫秒；守护进程常驻内存 < 20 MiB

**Constraints**: 判定必须在 `agent/turn-stopping` 监听器返回前完成注入；守护进程不得读写会话正文；不得阻塞 DSH 启动超过 5 秒

**Scale/Scope**: 单机 1–5 个 DSH 进程；状态表规模为「会话数 × 1」，数十条量级

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 检查 | 结论 |
|---|---|---|
| I 简单性优先 | 引入守护进程是**必要的**复杂度：跨进程共享状态没有更简单的实现（文件锁在 Node 生态里没有可靠内置） | 通过 |
| II 测试先行 | 每个切片先写失败测试；协议层用契约测试，双实现用 parity 测试 | 通过 |
| III 提示面与状态安全 | 注入仍由客户端在本进程执行，守护进程不直接碰 agent（FR-009）；注入带来源标记与轮次（既有行为不变）；取消不复活（`aborted` 由客户端判定并传参）；预算策略仍是「阈值触发复述 + 第 5 次用户提示」 | 通过 |
| IV 原子提交 | 分五个切片提交：协议层 → 守护进程 → 客户端接线 → 生命周期 → 降级与多进程验证 | 通过 |
| V 不审查不合并 | 触碰轮次边界与注入路径，必须过安全轴并补回归测试 | 通过（见 tasks 的验收项） |
| VI 可读性与显式契约 | 协议以 `contracts/ipc-protocol.md` 先定义再实现；无 `any` | 通过 |
| VII 复用宿主机制 | 不新增与宿主重叠的状态机；`MonitorState` 是既有 `state`/`forget`/`resume`/`turn` 的搬迁，不是第二套语义 | 通过 |

**再评估（Phase 1 后）**：设计新增了一个后台进程，属于「体系结构级」变化。它带来的主要风险不是逻辑错误，而是**故障面**——多了一个可能起不来、可能残留、可能版本不一致的东西。缓解措施已写入 FR-010/011/012/017/018 与 R-004/R-005/R-009。判为通过，但要求在 tasks 中为每个缓解措施配一条测试。

## Project Structure

### Documentation (this feature)

```text
specs/007-daemon/
├── plan.md              # 本文件
├── research.md          # Phase 0（R-001…R-012）
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── ipc-protocol.md  # Phase 1（C-001…C-013）
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2（/speckit-tasks 生成）
```

### Source Code (repository root)

```text
src/
├── index.ts             # 接线：事件 → monitor → 注入
├── config.ts            # 新增 daemon 相关配置（mode / socketPath 覆盖）
├── monitor/
│   ├── types.ts         # Monitor 接口与共享类型（Request/Response/MonitorState）
│   ├── local.ts         # LocalMonitor：包装既有 state/forget/resume/turn
│   └── remote.ts        # RemoteMonitor：RPC + 降级
├── ipc/
│   ├── protocol.ts      # 编解码、校验、错误码
│   ├── client.ts        # 连接、握手、重连、请求超时
│   └── launcher.ts      # spawn detached、陈旧 socket 检测与清理
├── daemon/
│   ├── main.ts          # 进程入口：listen、连接计数、宽限退出
│   ├── server.ts        # 请求分发、幂等缓存、异常隔离
│   └── state.ts         # MonitorState 表与状态转移
├── gate.ts              # 改为接受判定结果（注入动作留在客户端）
├── resume.ts            # 保留纯函数（classifyUpstreamError/shouldResume）
├── trace.ts             # 拆出 record 构造，写入由 monitor 决定
├── state.ts             # 保留，供 LocalMonitor 使用
├── forget.ts            # 同上
└── turn.ts              # 同上

tests/
├── unit/
│   ├── ipc-protocol.test.ts    # 编解码、校验、错误码
│   ├── daemon-state.test.ts    # 状态转移
│   └── launcher.test.ts        # 陈旧 socket 判定
├── integration/
│   ├── daemon-lifecycle.test.ts    # 拉起、退出、宽限、强杀自愈
│   ├── daemon-degrade.test.ts      # 不可用时的本地回退
│   └── daemon-multiprocess.test.ts # 两个客户端共享计数
└── contract/
    └── monitor-parity.test.ts  # Local 与 Remote 判定结果一致
```

**Structure Decision**: 单包布局延续现状；新增三个子目录按职责切分（`monitor` 是抽象与两实现，`ipc` 是传输，`daemon` 是服务端）。`gate.ts`/`resume.ts`/`trace.ts` 改造为**纯判定**，不再直接写状态与文件——这样 `LocalMonitor` 与 `RemoteMonitor` 能复用同一套判定逻辑，parity 测试才有意义。

## Complexity Tracking

| 违反项 | 为何需要 | 更简单的替代方案为何不够 |
|---|---|---|
| 新增后台进程（本仓库首次引入常驻进程） | 跨进程共享状态与单写留痕；宿主不提供跨进程状态服务 | 共享文件 + 锁：Node 无内置 `flock`，自旋锁在崩溃时会留下死锁文件，比多一个进程更难收拾 |
| 双实现（Local + Remote） | FR-017 要求降级可用 | 只保留 Remote：守护进程起不来时插件整体失效，比它要解决的问题更糟 |
| 协议版本协商 | 插件与守护进程生命周期不同步（前者随 npm 升级，后者常驻） | 无版本：字段变化表现为静默错误，归因成本高 |
