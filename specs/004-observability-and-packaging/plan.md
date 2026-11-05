# Implementation Plan: 可观测性与可分发

**Branch**: `004-observability-and-packaging` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-observability-and-packaging/spec.md`

## Summary

三件事合成一条规格：**留痕**（每次收尾判定落一条可检索记录）、**设置页**（参数在设置界面可改且即时生效）、**可分发**（能被打包成 bundle 并进市场）。

三者共享同一个根因：插件目前是黑盒——出了问题无法证明它跑过、参数只能改文件重启、别人装不上。做完之后，维护者能对着记录说清"这一轮为什么没拦"，用户能在界面里调参数，插件能被安装器识别。

## Technical Context

**Language/Version**: TypeScript 5.9（ESM，Node 24）

**Primary Dependencies**: `@deepseek-ai/cordis ~4.0.5`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`、Node `node:fs` / `node:os` / `node:path`

**Storage**: JSONL 追加文件（`$DSH_HOME/logs/target-monitor/gate-trace.jsonl`）+ 进程内环形缓冲（最近 200 条）

**Testing**: `npm test`（`node --test`）

**Target Platform**: 宿主 DeepSeek-Harness 0.2.1-rc.5

**Project Type**: 单包 DSH 插件

**Performance Goals**: 单条记录 ≤ 7 字段；每次判定一次追加写（失败即丢弃）；不引入额外事件订阅

**Constraints**:
- 记录绝不可进入模型可见面（FR-003）
- 留痕失败不影响判定（FR-007）
- 不改变既有判定语义（FR-016）

**Scale/Scope**: 新增 `src/trace.ts`；改 `src/gate.ts`（上报）、`src/config.ts`（volatile 化）；`package.json` + `dsh.bundle.patch`；预计 < 250 行（含文档）

## Constitution Check

| 原则 | 检查 | 结论 |
|---|---|---|
| I 简单性优先 | JSONL 追加 + 环形缓冲；不引数据库、不加客户端插件 | ✅ |
| II 测试先行 | 先写"每次判定产生一条记录"的失败测试 | ✅ |
| III 提示面与状态安全 | 记录只写文件与内存，绝不进消息/提示词/工具结果（FR-003 有断言测试） | ✅ |
| IV 原子提交 | 三个子能力各自独立提交（留痕 / 设置页 / 打包） | ✅ |
| V 不审查不合并 | 触碰文件写入与发布元数据，需过安全轴（路径穿越、敏感信息） | ✅ |
| VI 可读性与显式契约 | 记录字段写成显式类型与契约文档 | ✅ |
| VII 复用宿主机制 | 设置页复用 `dsh-settings` 的 volatile 表单；打包复用 `dsh-package-manifest` 约定 | ✅ |

**初判通过。**

## Project Structure

```text
specs/004-observability-and-packaging/
├── spec.md
├── plan.md                       # 本文件
├── research.md
├── data-model.md
├── contracts/
│   ├── trace-record.md
│   └── package-manifest.md
├── checklists/requirements.md
└── tasks.md

src/
├── trace.ts       # 新增：记录构造、追加写、环形缓冲、路径解析
├── gate.ts        # 每个判定出口上报一条
├── config.ts      # volatile 字段与阈值校验
└── index.ts       # 注册 trace 的 dispose

package.json       # dsh 清单、engines、files、keywords、去 private
dsh.bundle.patch   # 新增：bundle 补丁
```

**Structure Decision**: 留痕独立成模块（`trace.ts`），`gate.ts` 只负责"在每个出口报告"，不关心落盘细节。打包改动只在元数据层，不触碰运行时代码。

## Phase 0: Research

见 [research.md](./research.md)。

## Phase 1: Design

- [data-model.md](./data-model.md)：GateTrace 字段、保留策略、检索方式
- [contracts/trace-record.md](./contracts/trace-record.md)：写入与读取契约
- [contracts/package-manifest.md](./contracts/package-manifest.md)：bundle 与市场清单
- [quickstart.md](./quickstart.md)：可运行的验证步骤

### 变更点

**1. 留痕（`src/trace.ts` 新增）**

```ts
type GateOutcome = 'injected' | 'released'
type GateReason = 'undeclared' | 'declared' | 'disabled' | 'not-root' | 'aborted' | 'error'

interface GateTrace {
  at: number        // epoch ms
  session: string   // agent 标识短哈希，不含用户内容
  turn: number
  outcome: GateOutcome
  reason: GateReason
  attempt: number   // 本轮第几次注入；放行时为 0
}
```

- `recordTrace(entry)`：追加一行 JSONL；失败只记一次内部告警，不抛出（FR-007）。
- `recentTraces()`：返回环形缓冲快照，供测试与调试。
- 路径：`$DSH_HOME/logs/target-monitor/gate-trace.jsonl`；`$DSH_HOME` 缺失时回退 `os.tmpdir()`。
- 保留：单文件超过 2 MiB 时轮转为 `.1`，最多保留 2 个文件（FR-005）。

**2. 设置页（`src/config.ts`）**

- `enabled`、`stallNoticeThreshold` 已是 `.volatile()`；本特性补齐 005 新增的两个字段。
- FR-009 的"拒绝非法值并说明原因"由 `assertThreshold` 抛出带字段名的错误实现，`dsh-settings` 会把消息回显到表单。
- FR-010：插件从不主动依赖设置服务，缺席时天然照常工作。
- FR-011：写入优先级由宿主处理；插件不缓存配置，每次判定读当前值。

**3. 可分发（`package.json` + `dsh.bundle.patch`）**

- 移除 `"private": true`。
- 新增：
  ```json
  "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0" },
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "dsh.bundle.patch" } },
  "files": ["dist", "dsh.bundle.patch", "README.md"],
  "keywords": ["dsh", "dsh-plugin", "target-status", "turn-gate"]
  ```
- `dsh.bundle.patch` 声明插件挂载点（与 profile 的 `cordis.patch.yml` 同格式）。
- Peer 依赖保持现状（FR-015）：宿主包全部 `peerDependencies`。
- 发布通道：**npm 与 git 双通道**，仓库 `git@github.com:FirenzeClaw/dsh-Target-achieved.git`；两通道版本号必须一致，git 源的 `commit` 取该版本 tag 指向的提交。

### 关键取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 记录粒度 | 每次判定一条 | FR-001；比"只记注入"能回答"为什么没拦" |
| 存储介质 | JSONL 文件 | grep 即检索（FR-004），零依赖 |
| 检索入口 | 文件 + 内存快照 | 不新增工具（工具结果会进模型可见面，违反 FR-003） |
| 会话标识 | 短哈希 | 能区分 agent，又不落用户可识别信息 |
| 保留策略 | 2 MiB × 2 文件 | 约 2 万条，磁盘占用 < 5 MiB |

### 与 005 的关系

004 只提供"设置页能编辑 volatile 字段"这一能力；005 负责新增 `reminderThreshold` / `reactionWindowMs`。005 落地后 004 的 FR-008 自动覆盖新字段。

## Complexity Tracking

> 无违规。唯一需要说明的是 `trace.ts` 引入文件 I/O——但它被严格限制为"失败即丢弃"，不影响判定路径。
