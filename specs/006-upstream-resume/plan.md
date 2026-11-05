# Implementation Plan: 上游异常自动续行

**Branch**: `006-upstream-resume` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-upstream-resume/spec.md`

## Summary

宿主的 `dsh-llm-retry` 只负责**单次模型请求**的重试；重试耗尽后抛 `LlmError`，轮次以 `error` 结束，而 `agent/turn-stopping` 只挂在正常收尾路径上（`dsh-agent-loop/lib/index.js:1001` 位于 try 内且要求 `inbox.nextStep` 为空）。结果是上游抖动会把任务停在半路，没有任何自动补救。

本切片补上「轮次级恢复」：监听 `agent/error`，对可重试错误码在轮次 idle 后用 `agent.steer` 投递一条现有自救文案，自动开启新一轮；默认连续上限 3 次，正常收尾即清零。不可重试错误、用户取消、`enabled: false`、子 agent 一律不续行。留痕保持 `outcome` 两值不变，只新增三个 `reason` 与可选 `errorCode`。

## Technical Context

**Language/Version**: TypeScript 5.9.3 / ESM，Node.js v24.22.1

**Primary Dependencies**: `@deepseek-ai/cordis` ~4.0.5（宿主提供，peer）；`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm` 仅类型导入。**不新增运行时依赖**

**Storage**: 无持久化新增；续行计数为进程内 `WeakMap<Agent, ResumeState>`。留痕沿用既有 JSONL（`$DSH_HOME/logs/target-monitor/gate-trace.jsonl`）

**Testing**: `npm test`（`node --test`，Node 24 原生类型剥离）；新增单测 `tests/unit/resume.test.ts`，集成测试 `tests/integration/upstream-resume.test.ts`

**Target Platform**: DeepSeek-Harness `0.2.1-rc.5`（`engines.dsh: >=0.2.1-rc.5 <0.3.0`）

**Project Type**: DSH 插件（独立 npm 包）

**Performance Goals**: 单次判定 O(1)；不引入定时器，不轮询

**Constraints**: 不得在 `running` 阶段投递（不会唤醒驱动）；投递必须排在排队任务之前；不得重复实现退避重试

**Scale/Scope**: 新增 1 个模块（`src/resume.ts`）+ 3 处改动（`index.ts` / `config.ts` / `trace.ts`）；`prompt.ts`、`gate.ts`、`forget.ts` 不动。约 150 行实现

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 检查 | 结论 |
|---|---|---|
| I 简单性优先 | 复用 `repairText`、复用宿主可重试码白名单、复用既有 trace 通道；不新增文案、不新增文件格式 | 通过 |
| II 测试先行 | 分类矩阵、上限、清零、一轮一次、取消、留痕各写测试；先红后绿 | 通过 |
| III 提示面与状态安全 | 注入走 `agent.steer`（日志通道）；文案为常量且带来源标记；有明确预算策略（上限 3 + 达上限停手）；不复活取消 | 通过 |
| IV 原子提交 | 规格、实现、文档分三次提交 | 通过 |
| V 不审查不合并 | 触碰轮次边界与注入面，必须过安全轴并做反向验证 | 通过 |
| VI 显式契约 | 预算与分类写成 contracts；`ResumeState` 显式类型 | 通过 |
| VII 复用宿主机制 | **关键**：不碰 `agent/request-error`（那是 `dsh-llm-retry` 的地盘），只在其之后补轮次级恢复；与 `dsh-goal-round-driver` 的仲裁见 research R-005 | 通过 |

**Gate 结论**：通过，无违反项需要豁免。

**Phase 1 设计后复核**：新模块只做分类与计数，不新增依赖；注入仍走 `agent.steer`（日志通道），文案为既有常量；预算策略明确（上限 3 + 达上限停手 + 正常收尾清零）。设计未引入违反项，结论不变。

## Project Structure

### Documentation (this feature)

```text
specs/006-upstream-resume/
├── plan.md              # 本文件
├── research.md          # Phase 0：宿主行为核实与取舍
├── data-model.md        # Phase 1：ResumeState / 配置 / 留痕字段
├── quickstart.md        # Phase 1：可执行验证步骤
├── contracts/
│   ├── resume-decision.md   # 分类、上限、投递时序契约
│   └── trace-compat.md      # 留痕兼容契约
└── tasks.md             # Phase 2（由 /speckit-tasks 生成）
```

### Source Code (repository root)

```text
src/
├── resume.ts        # 新增：错误分类、续行计数、投递判定
├── index.ts         # 改：监听 agent/error、接线 whenIdle + steer、dispose 清理
├── config.ts        # 改：新增 resumeOnUpstreamError / maxResumes（均 volatile）
├── trace.ts         # 改：GateReason 扩三个值、GateTraceEntry 加可选 errorCode
├── gate.ts          # 不改
├── prompt.ts        # 不改（复用 repairText）
└── forget.ts        # 不改
tests/
├── unit/resume.test.ts              # 新增：分类矩阵与计数
└── integration/upstream-resume.test.ts  # 新增：驱动真实 apply
```

## Phase 0: Research

见 [research.md](./research.md)。六个待解问题：

1. 错误路径是否派发 `turn-stopping`（决定是否必须新开监听点）
2. `running` 阶段投递为何不生效（决定投递时机）
3. idle 后如何唤醒且排在排队任务之前（决定用 `steer` 而非 `followup`）
4. 错误分类的可信字段（决定用 `LlmError.code` 而非解析 message）
5. 与 `dsh-llm-retry` / `dsh-goal-round-driver` 的职责边界（决定不碰 `request-error`）
6. 留痕如何扩展才不破坏既有 `jq` 查询

## Phase 1: Design

### 变更点

| 文件 | 改动 |
|---|---|
| `src/resume.ts`（新增） | `RETRYABLE_CODES`、`classifyUpstreamError(error)`、`shouldResume(agent, turn)`、`noteResume(agent, turn)`、`resetResume(agent)`、`forgetResume(agent)` |
| `src/index.ts` | `ctx.on('agent/error', ...)`；接线 `whenIdle()` → `agent.steer(createNotice(...))`；`agent/disposed` 调 `forgetResume`；`assistant-stream` 的 finish 帧调 `resetResume` |
| `src/config.ts` | `resumeOnUpstreamError`（boolean，默认 true）、`maxResumes`（正整数，默认 3），均 `.volatile()`；`snapshot` 带上二者 |
| `src/trace.ts` | `GateReason` 加 `upstream-resumed` / `upstream-skipped` / `upstream-capped`；`GateTraceEntry` 加 `errorCode?: string` |

### 时序要点

```text
turn() 抛错
  → catch: turnEnds = {kind:"error"}
  → throwError() → emit("agent/error")     ← 此时 phase 仍为 running
  → 监听器：分类 + 判断 + 记 pending
  → 监听器：agent.whenIdle().then(...)     ← 不阻塞、不 await
  → throw 继续传播 → kick().finally: setPhase(idle)
  → whenIdle 兑现 → steer(message)
  → phase 为 idle，wakeDriver 起新一轮
  → 新一轮 step0：claim 先取全部 next-step（我们的消息），再取一条 next-turn
```

**禁止**在 `agent/error` 监听器内同步 `steer`：那一刻 `phase.kind === "running"` 且 abort 未触发，`wakeDriver` 不会置 `wakeRequested`（`dsh-agent-loop/lib/index.js:854-860`），消息只会滞留在队列里。

### 兼容性

- 留痕：`outcome` 仍为 `injected` / `released`；六个既有 `reason` 语义不变；新增三个值属追加，旧 `jq` 过滤不受影响；`errorCode` 为可选字段，缺失时老读者按 undefined 处理。
- 配置：两个新字段都有默认值，既有 profile 的 `config` 无需改动即可生效。
- 行为：`enabled: false` 时错误路径也不投递，与既有主开关语义一致。

## Complexity Tracking

无违反宪法项，无需豁免。

新增复杂度的两处，理由如下：

| 新增 | 为什么不复用 |
|---|---|
| `src/resume.ts` 独立模块 | 计数语义与 `forget.ts`（跨轮遗忘）完全不同：那是「声明晚了」的累计，这是「连续失败」的连续量，且清零条件不同。合在一起会让两个状态机互相干扰 |
| 新监听点 `agent/error` | 收尾门依赖 `turn-stopping`，而错误路径不派发该事件（已在 research R-001 核实），没有别的介入点 |
