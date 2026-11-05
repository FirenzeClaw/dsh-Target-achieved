# DSH-Target-achieved

为 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的**收尾门**插件：轮次即将关闭而模型没有声明目标状态时，注入一条自救提醒，让对话继续而不是静默断在半路。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-7c3aed.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Tests](https://img.shields.io/badge/tests-97%20passing-brightgreen.svg)](#开发)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](CHANGELOG.md)

## 目录

- [背景](#背景)
- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [工作原理](#工作原理)
- [留痕与排查](#留痕与排查)
- [覆盖边界](#覆盖边界)
- [开销](#开销)
- [开发](#开发)
- [版本与发布](#版本与发布)
- [贡献](#贡献)
- [许可](#许可)

## 背景

本项目解决的是**实际使用中的任务中断**：活还没干完，轮次却已经结束，用户看到的是一句"完成了"或者半截输出。

这类中断有几种来源，出现频率差别很大：

| 中断来源 | 实际占比 | 表现 | 本项目 |
|---|---|---|---|
| 思考泄露 / 工具调用畸形 | **主要** | 模型把推理过程或残缺的工具调用写进正文，随后结束轮次 | 在收尾处拦截：未声明目标状态不放行 |
| 任务中途收尾（模型以为说完了） | 极低 | 模型自认完成，直接结束 | 同上 |
| 输出被长度上限截断 | 偶发 | `max-tokens`，截断后的工具调用未执行 | 识别原因并说明 |
| 上游断流 / 限流 | 偶发 | 请求失败，重试耗尽后轮次以错误结束 | 重试由宿主负责；耗尽后的兜底见[覆盖边界](#覆盖边界) |

关键点：**前两类在本插件眼里是同一件事**——轮次在没有任何目标状态声明的情况下结束了。插件不判断"为什么"结束，只在收尾处拦截，因此思考泄露与工具调用畸形造成的静默收尾同样会被拦下，并得到一条明确的续行指令。

## 特性

- **收尾拦截**：未声明目标状态时不放行轮次，注入一条归属 `target-monitor` 的提醒。不区分中断的上游原因——思考泄露、工具调用畸形、模型自认完成，都在此拦下。
- **两种结束原因**：区分普通收尾与 `max-tokens` 截断，后者额外说明工具调用未执行。
- **跨轮复述**：累计遗忘达阈值后，下一次提醒末尾追加声明规范复述。
- **判定留痕**：每次判定落一条 JSONL 记录，放行也记，六种原因可区分。
- **设置页可改**：`enabled` / `reminderThreshold` / `reactionWindowMs` 在宿主设置页即时生效。
- **三种安装方式**：bundle、git 源、本地 link。

## 安装

```bash
# 1. 作为 bundle（安装器读取 dsh.bundle.patch 并写入 profile 补丁层）
dsh plugin --profile web add dsh-target-monitor

# 2. 从 git 源
dsh plugin --profile web add git+ssh://git@github.com/FirenzeClaw/dsh-Target-achieved.git

# 3. 本地开发
dsh plugin --profile web add /path/to/DSH-Target-achieved
```

也可以直接编辑 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: target-monitor
      name: 'dsh-target-monitor'
      config:
        enabled: true
        stallNoticeThreshold: 5
```

安装后重启 `dsh web`：系统提示词章节与工具 schema 都在进程启动时注册。

## 快速开始

装好之后，模型在收尾前调用一次工具即可：

```jsonc
// 任务完成，准备汇报
{ "state": "done" }

// 需要用户决定，准备提问
{ "state": "awaiting_user" }
```

不调用就收尾，插件会拦下来并注入提醒；声明 `done` 或 `awaiting_user` 后放行。

## 配置

| 字段 | 类型 | 默认 | 设置页 | 说明 |
|---|---|:--:|:--:|---|
| `enabled` | boolean | `true` | 是 | 总开关；关闭时判定直接放行，工具拒绝声明 |
| `reminderThreshold` | 正整数 | `3` | 是 | 累计几次遗忘后复述一次声明规范 |
| `reactionWindowMs` | 正整数 | `30000` | 是 | 注入后多久内的声明算作"被提醒才想起来" |
| `stallNoticeThreshold` | 正整数 | `5` | 否 | 本轮第几次未声明时向用户发"可能卡住"提示 |

标记为"设置页"的字段声明为 `volatile`，改动后立即生效，无需重启。`stallNoticeThreshold` 参与告警节奏，热改语义尚未在真实会话中验证，当前只支持通过 `cordis.patch.yml` 修改。

非法值在保存或启动时抛出并指明字段，不回退默认值——静默回退会让"改了没反应"成为最难排查的一类故障。

## 工作原理

1. 插件注册一节系统提示词，要求模型在收尾前声明目标状态（先声明，再汇报或提问）。
2. 提供 `target_status` 工具作为声明通道；插件不解析自然语言。
3. 宿主在轮次即将关闭时派发 `agent/turn-stopping`，插件据此判断：
   - 已声明 → 放行；
   - 未声明 → 注入提醒并把消息排到队首，轮次继续。
4. 提醒显式标注它不是用户消息、不构成任何授权，并为"我在等用户确认"留出口。
5. 同一轮第 5 次仍未声明 → 向用户发一条"可能卡住"提示，每轮一次。
6. 跨轮累计：注入后 30 秒内声明成功记一次"遗忘"；累计 3 次后，下一次提醒追加复述并清零。

状态只存内存，按「顶层 agent × 轮次」定位。子 agent 不设门。

## 留痕与排查

每次判定落一条记录，**放行也记**——否则"没注入"与"没运行"无法区分。

```bash
# 某一轮的全部判定
jq -c 'select(.turn == 7)' ~/.dsh/logs/target-monitor/gate-trace.jsonl

# 最近 20 条
tail -n 20 ~/.dsh/logs/target-monitor/gate-trace.jsonl | jq -c .
```

| 字段 | 说明 |
|---|---|
| `at` | 判定时刻（epoch ms） |
| `session` | agent 标识的 8 位十六进制短哈希 |
| `turn` | 轮次号；未知为 `-1` |
| `outcome` | `injected` 或 `released` |
| `reason` | `undeclared` / `declared` / `disabled` / `not-root` / `aborted` / `error` |
| `attempt` | 本轮第几次注入；放行时为 `0` |

**某轮查不到记录，表示该轮未被判定。** 单文件超 2 MiB 轮转为 `.1`，保留两代。

记录只写文件与内存缓冲，不进入对话消息、系统提示词或工具返回值——工具结果必然进模型上下文，因此本项目不提供查询工具。

## 覆盖边界

### 已覆盖

插件的治理对象是一个事实：**轮次收尾时是否调用过 `target_status`**。它不区分中断的上游原因，因此下列情形都在覆盖范围内：

| 情形 | 处理 |
|---|---|
| 思考泄露后直接收尾 | 未声明 → 注入续行提醒 |
| 工具调用畸形、调用被丢弃后收尾 | 未声明 → 注入续行提醒 |
| 模型自认完成但没声明 | 未声明 → 注入续行提醒 |
| 输出被 `max-tokens` 截断 | 注入提醒并说明截断后的工具调用未执行 |
| 同一轮反复不声明 | 第 5 次向用户发"可能卡住"提示，由用户决定是否中断 |
| 用户取消轮次 | 不注入、不复活；下一次输入恢复门控 |

### 部分覆盖：上游断流 / 限流

分层看这件事：

1. **单次请求失败**由宿主 `agent/request-error` 接管重试（waterfall 返回 `{ kind: 'retry' }`）。这一层本项目不重复实现。
2. **重试耗尽**后，轮次以 `error` 结束。宿主此时走 `agent/error` 事件，**不派发 `agent/turn-stopping`**（`dsh-agent-loop/lib/index.js:1001` 的派发位于正常收尾路径内），因此本插件当前**不介入这一类结束**。
3. 第 5 次"可能卡住"提示的触发条件是**同一轮内被注入 5 次仍未声明**，属于模型反复不配合的信号，与上游错误不是同一条路径。

所以现状是：上游不稳定时，宿主的重试层在工作，但重试耗尽后的静默结束目前没有兜底。这是已知缺口，补法是在 `agent/error` 上挂一条面向用户的提示（不注入模型、不复活轮次），计划单独立项。

### 不在范围内

| 项 | 归属 |
|---|---|
| 子 agent 的轮次 | `ctx.agents.roots()` 之外一律不介入 |
| 任务是否真的完成 | 模型的判断，插件只读声明 |
| 重试策略本身 | 宿主 `agent/request-error` |
| 流式渲染与工具参数校验 | 流式层与工具层 |

### 能力声明

以下六条是事实陈述，构成本项目的能力边界：

1. **声明是模型自述。** 插件读取并记录声明，据此放行；它不验证任务是否真的完成。模型判断失误而在未完成时声明 `done`，插件照常放行。
2. **注入是提醒，不是命令。** 模型可以忽略提醒继续收尾；插件在同一轮内会再次注入，不设硬上限（当前策略：第 5 次向用户发一次提示，由用户决定是否中断）。
3. **判定依据是宿主事件。** 插件订阅 `agent/turn-stopping` 与 `agent/assistant-stream`，按 `0.2.1-rc.5` 的契约实现。宿主升级后这些契约可能变化，需要重新核对，依赖点记录在 [`AGENTS.md`](AGENTS.md) 的「宿主事实速查」。
4. **取消即刻生效。** 用户取消轮次后插件不再注入，也不复活该轮；下一次用户输入自动恢复门控。
5. **留痕是旁路。** 磁盘写入失败时插件继续判定与注入，只告警一次。
6. **上游断流只覆盖到重试层之前。** 单次请求失败由宿主 `agent/request-error` 重试；重试耗尽后轮次以 `error` 结束，宿主不派发 `agent/turn-stopping`，插件不介入这一类结束。

### 版本兼容

| 项 | 范围 |
|---|---|
| Node.js | `>=22` |
| DeepSeek-Harness | `>=0.2.1-rc.5 <0.3.0` |
| 许可 | MIT |

宿主主版本变化（`0.3.x`）视为不兼容：事件契约与工具注册方式可能改变，需要重新验证后放宽范围。

## 开销

本插件有三处固定成本，数字为实测。

| 项 | 字符数 | 约合 token | 频率 |
|---|---:|---:|---|
| 系统提示词章节 | 433 | 110–160 | 每轮（同会话前缀稳定，可被 prompt cache 复用） |
| 注入提醒 | 647 | 170–220 | 每次未声明收尾 |
| 规范复述 | 306 | 80–100 | 每累计 3 次遗忘 |

真正的成本不是这些字符，而是**可能多一轮**：模型收到提醒后要先声明再汇报，多数场景下会多一次模型请求。实测 8 次注入全部在 8–19 秒内被响应，中位数约 9.6 秒——这段时间就是额外开销。

开销上有三处收敛：只有未声明才注入；向用户发提示每轮至多一次；复述按累计次数节流。

短会话、一次性问答的场景里，收尾门的收益可能小于固定开销；长任务、多步实现、需要收尾汇报的场景是它的目标场景。

## 开发

```bash
npm install
bash scripts/link-host.sh   # 开发期链接宿主已安装的 @deepseek-ai 包

npm run typecheck
npm test                    # node --test，97 项
npm run build
```

目录结构、宿主事实与编码约定见 [`AGENTS.md`](AGENTS.md)，设计取舍见 [`docs/PLUGIN-DESIGN.md`](docs/PLUGIN-DESIGN.md)。

## 版本与发布

版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

`0.x` 阶段：事件契约调整按次版本发布；宿主主版本跃迁（如 DSH `0.3.x`）或插件导出面变化按主版本考虑。

npm 与 git 两条通道同时发布，同一版本号在两处指向同一份代码：

```bash
npm version <patch|minor|major>   # 同步 package.json 与 tag
npm publish
git push --follow-tags origin master
```

git 源的 `commit` 取该版本 tag 指向的提交，不使用分支 HEAD。

## 贡献

Issue 与 PR 都欢迎。提交前执行：

```bash
npm run typecheck && npm test && npm run build
```

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，格式 `<type>(<scope>): <subject>`。触碰提示词注入、轮次边界或重试策略的改动需附带回归测试。

## 许可

本项目以 [MIT 许可](LICENSE)发布，版权归 © 2026 FirenzeClaw 所有。

MIT 允许使用、修改、再分发与商业用途，条件是保留版权声明与许可声明；完整条款见 [`LICENSE`](LICENSE)。

本项目依赖 DeepSeek-Harness 的内部事件契约，用于生产前请在目标版本上验证——[`specs/001-target-monitor/quickstart.md`](specs/001-target-monitor/quickstart.md) 提供了可执行的验证步骤。
