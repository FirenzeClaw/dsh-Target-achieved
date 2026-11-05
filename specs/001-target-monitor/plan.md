# Implementation Plan: 目标达成监测器（收尾门）

**Branch**: `001-target-monitor` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-target-monitor/spec.md`

## Summary

在 DSH 宿主的"轮次即将关闭"拦截点做一次判定：模型若未显式声明目标状态（完成 / 等待用户），就投递一条带来源归属的自救提醒并要求继续，直到声明或用户取消。仅覆盖顶层 agent 的轮次；不重试请求、不检测内容质量、不解析自然语言。

技术要点：单钩子（`agent/turn-stopping`）、单工具（`target_status`）、单份内存状态（按 agent × turn）。详见 [research.md](./research.md) 与 [docs/PLUGIN-DESIGN.md](../../docs/PLUGIN-DESIGN.md)。

## Technical Context

**Language/Version**: TypeScript 5.x（ESM）；Node.js ≥ 22，开发机 24.22.1

**Primary Dependencies**: `@deepseek-ai/cordis` ~4.0.5（peer）、`@deepseek-ai/schemastery`（配置 schema）、`@deepseek-ai/dsh-{agent,llm,tools,system-prompt}`（peer，类型与运行时契约）、宿主 DSH `0.2.1-rc.5`

**Storage**: 无持久化。状态仅存内存，按 (agent, turn) 键，随轮次结束失效

**Testing**: `node --test` + Node 24 原生 TS 类型剥离；零测试框架依赖（已实测：`/tmp/ts-probe` 两个用例通过）

**Target Platform**: DeepSeek-Harness 0.2.1-rc.5（cordis 插件）；宿主 Node 运行时

**Project Type**: library（cordis 插件包，经 profile 挂载）

**Performance Goals**: 已声明轮次零额外开销（放行判定为 O(1) 内存查表）；未声明轮次每次多一个模型步骤；不引入额外请求

**Constraints**: 注入不得晚于轮次关闭、不得阻塞用户取消、不得污染系统提示词前缀（静态注册一次）、不得拼接外部文本

**Scale/Scope**: 单会话单顶层 agent；每轮状态条目数 = 1；无跨会话共享

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 判定 | 依据 |
|---|---|---|
| I. 简单性优先 | PASS | 单钩子 + 单工具 + 单状态；无重试器、无内容检测、无持久化 |
| II. 测试先行 | PASS | 计划要求先落 `node --test` 用例；M1 每个切片带测试 |
| III. 提示面与状态安全 | PASS | 仅走日志通道；来源归属；非授权声明；取消不复活。预算策略为"不设上限 + 第 5 次用户通知"，已随宪法 v1.1.0 的措辞修订对齐（见 Sync Impact Report） |
| IV. 原子提交与主干开发 | PASS | 切片 M1–M3 各自独立提交 |
| V. 不审查不合并 | PASS | 切片完成后按五轴审查；触碰注入/边界须过安全轴 |
| VI. 可读性与显式契约 | PASS | `contracts/` 定义工具与消息契约；导出显式类型 |
| VII. 复用宿主机制 | PASS | 复用 `turn-stopping`、`FinishReason`、notice 通道；不造 goal 平行状态 |

**Phase 1 后复检**：设计未引入新组件或新依赖，判定不变。

## Project Structure

### Documentation (this feature)

```text
specs/001-target-monitor/
├── plan.md              # 本文件
├── research.md          # Phase 0：技术决策与替代方案
├── data-model.md        # Phase 1：状态与实体
├── quickstart.md        # Phase 1：端到端验证步骤
├── contracts/           # Phase 1：工具 / 消息 / 插件入口契约
├── checklists/
│   └── requirements.md  # 规格质量清单
└── tasks.md             # Phase 2（/speckit-tasks 生成）
```

### Source Code (repository root)

```text
src/
├── index.ts             # 插件入口：name / inject / Config / apply
├── config.ts            # schemastery 配置与快速失败校验
├── state.ts             # (agent, turn) → 目标状态、修复计数、通知标记
├── cause.ts             # 从 assistant-stream 的 finish 块记录 StopCause
├── gate.ts              # turn-stopping 判定：放行 / 提醒
├── tool.ts              # target_status 工具注册
├── prompt.ts            # 系统提示词章节与自救提醒文案
└── notices.ts           # notice 消息构造（来源、summary、非授权条款）

tests/
├── unit/
│   ├── config.test.ts   # 配置校验：非法值必须抛出
│   ├── state.test.ts    # 状态与轮次重置
│   ├── gate.test.ts     # 放行 / 提醒 / 取消 / 无上限 / 第 5 次通知
│   ├── cause.test.ts    # FinishReason → StopCause 归一化
│   └── prompt.test.ts   # 文案必须含非授权条款与三个出口
└── integration/
    └── turn-gate.test.ts # 假 agent 上跑完整收尾流程

scripts/
└── link-host.sh         # 开发期把宿主 @deepseek-ai 包链接到本地 node_modules
```

**Structure Decision**: 单项目结构（Option 1）。插件是单个 npm 包，无前后端拆分；`src/` 按"入口 / 状态 / 判定 / 文案 / 投递"分文件，每个文件一个职责，便于单测直接 import 而不必启动宿主。

## Complexity Tracking

无宪法违反项。

> 历史记录：本计划初稿曾把"不设修复上限"记为 CT-1 例外。`/speckit-analyze` 指出，以"记录例外"方式稀释宪法原则不合规。处置：宪法 III 于 2026-11-05 修订为 v1.1.0，把"必须有上限"改为"必须有明确的预算策略（上限、阈值触发的用户通知、退避或熔断至少其一）"。本特性的"不设上限 + 第 5 次用户通知"因此合规，例外记录撤销。

## Phase 输出

- **Phase 0**：[research.md](./research.md) — 9 项技术决策，含替代方案与否决理由
- **Phase 1**：[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)
- **Phase 2**：`/speckit-tasks` 生成 `tasks.md`（本命令不产出）
