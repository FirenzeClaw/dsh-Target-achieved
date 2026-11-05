# DSH-Target-achieved — AGENTS.md

<!-- AUTO:PROJECT-META -->
## 项目元信息

- 项目：DSH-Target-achieved
- 目标：解决实际使用中的任务中断——在轮次收尾处判断是否有过目标状态声明，未声明则注入续行提醒。不区分中断的上游原因（思考泄露、工具调用畸形、模型自认完成），只治理"静默结束"这一共同后果
- 技术栈：TypeScript + ESM；Node.js（本机 v24.22.1）；cordis `~4.0.5` 插件模型；宿主 DeepSeek-Harness `0.2.1-rc.5`
- 类型：DSH 插件（独立 npm 包，挂载进 profile）
- 初始化日期：2026-11-05
<!-- /AUTO:PROJECT-META -->

<!-- AUTO:STRUCTURE -->
## 目录结构

```
DSH-Target-achieved/
├── AGENTS.md                  # 本文件：项目级上下文
├── README.md                  # 面向使用者的入口（GitHub 结构：背景/安装/配置/范围声明/许可）
├── CHANGELOG.md               # Keep a Changelog 格式；版本号与 package.json 一致
├── package.json               # ESM 包；peer 依赖由宿主提供
├── LICENSE                    # MIT 许可全文（package.json 声明 MIT，必须真有此文件）
├── dsh.bundle.patch           # bundle 补丁：只做 insert，不改宿主既有条目
├── tsconfig.json              # NodeNext + 导入后缀重写
├── src/                       # 插件实现
│   ├── index.ts               # 入口：注册章节 / 工具 / 事件
│   ├── config.ts              # 配置校验（非法值抛出）
│   ├── state.ts               # (agent, turn) → 目标状态
│   ├── forget.ts              # 跨轮遗忘计数（复述触发）
│   ├── resume.ts              # 上游错误分类与连续续行计数
│   ├── trace.ts               # 判定留痕（JSONL + 环形缓冲）
│   ├── cause.ts               # FinishReason → StopCause
│   ├── gate.ts                # 收尾门判定与注入策略
│   ├── tool.ts                # target_status 工具
│   ├── paths.ts               # $DSH_HOME 解析（socket / pid / 日志目录）
│   ├── monitor/               # 判定通道：types / plan（纯函数）/ compose / local / remote
│   ├── ipc/                   # 守护进程传输：protocol / client / launcher
│   ├── daemon/                # 守护进程：main（生命周期）/ server（分发）/ state（状态表）
│   ├── client/                # 浏览器端：设置分区（单文件 + shims.d.ts）
│   ├── prompt.ts              # 系统提示词章节与固定文案
│   ├── notices.ts             # 消息来源归属与构造
│   └── turn.ts                # 轮次来源（声明与判定共用）
├── tests/
│   ├── unit/                  # state / config / cause / prompt / gate / forget / trace / manifest
│   └── integration/           # 假 agent 上的完整收尾流程
├── scripts/link-host.sh       # 开发期链接宿主 @deepseek-ai 包
├── scripts/build-client.mjs   # 把 tsc 的 CJS 客户端产物套上 ModuleLoader 包装
├── docs/
│   └── PLUGIN-DESIGN.md       # 设计取舍 + 宿主事件面调研结论（事实来源）
├── specs/
│   ├── 001-target-monitor/    # 收尾门特性：spec / plan / tasks / contracts
│   ├── 002-turn-key-alignment/ # 轮次键对齐：声明与判定共用同一轮次
│   ├── 004-observability-and-packaging/  # 留痕 / 设置页 / 可分发
│   ├── 005-declaration-reminder/         # 声明规范复述
│   ├── 006-upstream-resume/              # 上游异常自动续行
│   ├── 007-daemon/                       # 跨进程监测守护
│   └── 008-prompt-optout/                # 初始注入开关与设置界面接管
├── .specify/                  # speckit 脚手架
│   └── memory/constitution.md # 项目宪法（v1.1.0）
└── .dsh/skills/               # speckit-* 技能
```

构建产物在 `dist/`（已 gitignore）。
<!-- /AUTO:STRUCTURE -->

<!-- AUTO:BUILD -->
## 构建与运行

- 安装：`npm install`（peer 依赖由宿主提供，本地用 `bash scripts/link-host.sh` 链接；已装 `typescript@5.9.3`、`@types/node`）
- 构建：`npm run build` → `tsc -p tsconfig.json && tsc -p tsconfig.client.json && node scripts/build-client.mjs`；服务端产物在 `dist/`，客户端 bundle 在 `dist/client.js`
- 客户端构建约束：产物必须是 `window.__ModuleLoader__.load({id, factory})` 包装的 CommonJS，依赖只走裸模块名；`build-client.mjs` 会在出现相对 `require` 时直接报错
- 类型检查：`npm run typecheck` → 两个工程都过一遍：`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit`
- 测试：`npm test` → `node --test`（Node 24 原生类型剥离，零测试框架依赖）
- 守护进程手工验证：`node dist/daemon/main.js --socket /tmp/tm.sock --pid /tmp/tm.pid`（前台跑，Ctrl-C 退出）
- 挂载：profile 的 `cordis.patch.yml` `insert` 条目，或 `dsh plugin --profile web add <包名>`

**当前实测状态（2026-11-05）**：`typecheck` 通过、`build` 通过、`npm test` 197 项全通过。插件已在真实会话中跑通：三种状态（未声明→注入、声明 `done`→放行、声明 `awaiting_user`→放行）、轮次键对齐、注入有效性（8 次注入全部在 8–19 秒内被响应）。007 的跨进程能力用真实 socket 集成测试与手工双客户端验证（共享计数、强杀后自愈、宽限退出），**尚未在真实多入口场景长期观察**。**阈值提示（第 5 次未声明）仍未验证** -- 见 `specs/001-target-monitor/quickstart.md`。

**版本**：`0.4.2`（修复设置分区空白、阈值不可调、判定请求被缓存回放）。`0.2.0` 为上游异常自动续行，`0.1.0` 为首个正式发布。四个版本都已打 tag 并推送：`v0.1.0`（首个发布）、`v0.2.0`（上游续行）、`v0.3.0`（跨进程守护）、`v0.4.0`（设置界面接管）、`v0.4.1`（设置分区两处修复）、`v0.4.2`（判定请求不再走幂等缓存）。语义化版本，`0.x` 阶段事件契约调整按次版本发布；宿主主版本跃迁按主版本考虑。改动用户可见行为时同步 `CHANGELOG.md`——`tests/unit/manifest.test.ts` 会校验当前版本在 CHANGELOG 中有条目。

**守护进程生命周期（2026-11-05）**：连接计数 + 宽限。客户端是**常驻连接**（`src/monitor/remote.ts` 缓存 `client`），因此"最后一个连接断开"等价于"最后一个 DSH 进程退出"。宽限 30 秒后退出并删除 socket/pid；`SIGTERM`/`SIGINT` 也清理。`--grace <ms>` 可缩短宽限，供测试与手工验证真实退出路径（`tests/integration/daemon-exit.test.ts` 用子进程验证）。

> 曾有一个缺陷：默认退出回调只 `process.exit(0)`，不清理文件；测试因为注入了会 `close()` 的 `onExit` 而没暴露。生产路径下 socket/pid 会残留到下一个客户端 `cleanStale` 收掉。已修。

> **排查注入时要看留痕的 `at`，不要看消息到达时间。** 注入投递到下一步，长轮次里它可能一直排在 inbox 里，等这一轮真正结束才出现在对话里。实测一次 turn 42 的判定发生在 17:39:42，提醒直到 19:11 才显示——期间我误以为是"刚刚这轮又被拦了"。判定是否发生、判定的是哪一轮，只以 `~/.dsh/logs/target-monitor/gate-trace.jsonl` 的 `at`/`turn` 为准。

> **已修：同一轮无限重复注入（2026-11-05 19:21）。** 守护进程的幂等缓存曾把 `turn-stopping` 也缓存（键 `session:turn:type`）。
> 门注入后宿主再跑一步、同一轮再次收尾，第二次请求命中缓存又拿到 `inject: true`——注入、再注入停不下来；
> 且缓存短路发生在 `dispatch` 之前，**连留痕都不写**，现场表现为"每轮收到同一条 `attempt 1` 提醒、留痕零新增"。
> 现只缓存副作用请求（`turn-start`/`declare`/`finish`/`dispose`），判定类请求一律重算（契约 C-008a）。
> 教训：**判定类接口不要复用"重复请求返回首次结果"的通用缓存**——它的答案本来就是状态的函数。

**守护进程实测（2026-11-05）**：单次 RPC 0.13 毫秒（500 次平均）；空闲 RSS 51 MiB、2000 次请求后 58 MiB；socket 权限 0600、`run/` 目录 0700。这些数字写在 README「开销」与 `specs/007-daemon/plan.md`，改动实现后需重测。

**发布**：npm 与 git 双通道，仓库 `git@github.com:FirenzeClaw/dsh-Target-achieved.git`。`package.json` 含 `dsh.manifestVersion: 1` + `dsh.bundle.patch`，支持 bundle / git / 本地 link 三种安装方式。

> 2026-11-05 修复两处：① `apply` 会对宿主已解析的配置重跑 `Config`，volatile 的 `enabled` 被当成布尔值校验，插件整条 entry 变 inactive（见 `src/config.ts` 的 `isVolatileRef`）；② 声明曾写到上一轮的键上（spec 002），轮次来源已统一到 `src/turn.ts`，写入点在 `assistant-stream` 的 `start` 帧。

> 曾一度记录的"缺陷二：加载后首个收尾判定不触发"**经会话日志核实不成立**：11:53 加载后的第一轮（turn 3）正常注入，未注入的 turn 2 结束于 11:46（早于加载 7 分钟）。结论已撤销，勿据此排查。

> 任何新增脚本都要在这里写实命令；未在本节出现的命令不得在交付说明里声称"已通过"。
<!-- /AUTO:BUILD -->

## 宿主事实速查（2026-11-05 核实，版本 0.2.1-rc.5）

本插件依赖宿主内部契约，以下为已核实事实。改动前先复核，不要凭记忆。

**插件形态**：ESM 模块，导出 `name`、`inject`、`Config`（`@deepseek-ai/schemastery`）与 `apply(ctx, config)`。系统提示词通过 `ctx.systemPrompt.section({ name, order, text })` 注册。

**关键事件**（`@deepseek-ai/cordis` Events）：

| 事件 | 模式 | 对本插件的意义 |
|---|---|---|
| `agent/turn-stopping` | serial，awaited | 轮次即将关闭（模型不再欠响应）。监听器可 `agent.steer()` 反对关闭，机器会重读 inbox 再跑一步——**但只在正常收尾路径派发**（`dsh-agent-loop/lib/index.js:1001` 位于 try 内），错误路径不派发 |
| `agent/error` | emit | step/turn 出错，携带原始 error；**取消路径不派发**（catch 命中 abort 分支直接 throw，不调 `throwError`，`index.js:1010-1016`）。上游续行挂在这里 |
| `agent/request-error` | waterfall | 单次模型请求失败，返回 `{ kind: 'retry' }` 可接管重试——**上游不稳定的既有层，不要重复实现** |
| `agent/status` | emit | `idle` ⇄ `running` |
| `agent/pre-step` | waterfall | 可拒绝或用新消息替换即将进入步骤的批次 |
| `agent/inbox/*` | emit | 收件箱插入/领取/丢弃 |

**终止原因**：`@deepseek-ai/dsh-llm` 的 `FinishReason` 为 `stop` / `tool-calls` / `max-tokens` / `aborted` / `error`（后两者带 `failure`）。它作为 `StreamChunk` 的 `finish` 变体，经 `agent/assistant-stream` 的 `chunk` 帧可达——**分类停止原因用它，不要解析文本**。`max-tokens` 时 `BlockAssembler` 会丢弃无法执行的工具调用。

**既有 goal 机制**（不要另造平行状态机）：

- `@deepseek-ai/dsh-goal`：持久 goal（`objective` / `phase: active|paused|blocked|complete` / `maxGoalRounds` / `revision` CAS），进程内 `activation: armed|disarmed`
- `@deepseek-ai/dsh-tool-goal`：`get_goal` / `create_goal` / `update_goal`；`create`/`edit`/`pause`/`resume` 要求顶层人类直接请求；`complete`/`blocked` 在自主 Goal Round 中允许，`blocked` 需连续 N 轮（默认 3）
- `@deepseek-ai/dsh-goal-round-driver`：agent idle 且 goal active+armed 且有额度时，用 `agent.followup()` 排入 `<goal_round>` 提示词；**遇 max tokens / 持久化失败 / 取消 / 额度耗尽即停止，异常不自动重试**——这正是本插件要补的缺口

**客户端插件（浏览器端）**：宿主只服务**已构建**的产物，缺文件会**启动即失败**（`dsh-client-modules/README.md`「Build requirements」）。

- 产物格式：`window.__ModuleLoader__.load({ id, factory: (require) => { /* CommonJS */ } })`，依赖经**裸模块名** `require` 从宿主模块表取；相对路径不被解析。
- 声明：`package.json` 的 `dsh.client.platform = "web"` + `exports["./client"]`。
- 模块表里有 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等；实测宿主自身的客户端产物开头与本包一致。
- 分区注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label }, Component))`，客户端 `inject` 至少含 `slots`。
- 配置读写：`ctx.remote.settings.describe()` / `update(ns, patch, expectedRevision)`；返回 `RemoteResult<T> = { ok: true, value } | { ok: false, error }`；冲突码 `SETTINGS_CONFLICT`。
- **`remote.settings` 必须单独注入**：`inject = ['remote', 'remote.settings', 'slots']`。typert 远程代理的属性有独立访问门，只注入 `remote` 时读 `ctx.remote.settings` 会抛 `cannot get property "remote.settings" without inject`；抛出点在组件渲染期，宿主把整条 section 撤下（面板空白，控制台只有 `slot entry crashed in 'settings.section'`），类型检查发现不了。
- **设置文档只包含 volatile 字段**：`SettingsNamespaceView.value` 里只有 `.volatile()` 声明的键。非 volatile 字段既读不到也写不进，所以要让某项可在界面调节，必须先把它改成 volatile（`stallNoticeThreshold` 就是这么改的）。
- 分区 id 必须与 profile 条目 id 一致（`target-monitor`）：宿主按 `id` 做 `only` 过滤，nav 有项但面板空白通常意味着渲染期抛错被撤下，而不是 id 不匹配。
- 本包的构建方式：`tsc -p tsconfig.client.json` 出 CommonJS，再由 `scripts/build-client.mjs` 套包装（**不引入 bundler**）；客户端因此必须单文件。

**本机路径**（只读参考，不要修改宿主安装）：

```
/home/firenzeclaw/.nvm/versions/node/v24.22.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
```

## 工具优先级

1. **代码结构理解优先用 codegraph**（`codegraph_explore`），不可用时降级 grep/glob/read
2. **项目记忆**：本机无 memory 后端（`project-bootstrap` Step 2 已跳过）。跨会话结论写入 `.specify/memory/` 与 `docs/`，架构决策追加到 `docs/PLUGIN-DESIGN.md`；不要伪造 `memory_get`/`memory_set` 调用
3. 文件操作用专用工具（read/write/edit/glob/grep），不滥用 shell

<!-- AUTO:CONVENTIONS -->
## 编码约定

### 命名

- 函数：动宾结构（`resolveStopCause`、`isRecoverableStop`）
- 变量：名词短语（`activeRepairCount`），禁缩写、禁 1-2 字符名
- 常量 UPPER_SNAKE_CASE（`DEFAULT_MAX_REPAIRS_PER_TURN`）；布尔用 `is`/`has`/`can` 前缀

### 控制流

- Guard clauses 优先，嵌套 ≤3 层
- 复杂条件提取为布尔变量
- 函数超过 50 行考虑拆分；magic number 改为命名常量

### 注释

注释说 why，代码说 what。注释用中文，标识符、命令、API 名保留英文。

- **文件头**：每个 `.ts` 首段 JSDoc 说明模块职责与关键入口
- **功能标注**：`[WIP]` / `[DONE]` / `[UNCERTAIN]` / `[WORKAROUND]` / `[STUB]`；`TODO` 只用于待办，不作状态
- **必须加注释的位置**：每次外部 API/宿主事件调用（说明目的与失败影响）；≥3 条件的分支（说明每种走向）；硬编码阈值（说明取值来源）；任何与宪法原则相关的取舍
- **禁止**：把代码翻译成自然语言的注释；行尾注释；用注释记录"待办"而不建任务

### 类型与不可变

- 显式标注函数签名与导出返回值；禁止 `any` / 非必要 `as`
- 更新对象/数组用不可变方式（spread、`map`/`filter`），禁止直接 mutate 宿主传入的 payload

### 错误处理

- 宿主事件监听器内的异常必须就地捕获并记录——一个插件抛错不应打断整轮对话
- 空 `catch` 禁止；错误信息要带失败类别、轮次、步号、重试次数
- 宿主 payload 不可信：边界处校验一次，再进入内部逻辑

### 插件特有约束

- 影响模型可见内容的操作只走日志通道（系统提示词章节 / `inject` / `steer` / 工具结果）
- 所有注入必须带来源标记与原因，并受既定的预算策略约束。当前有两条：收尾门的修复（不设硬上限，第 5 次向用户发 notice）与上游续行（`maxResumes`，默认 3 次，正常收尾清零）
- 用户取消不得被自动复活；下一轮用户输入后自动恢复
<!-- /AUTO:CONVENTIONS -->

## Git 约定

- 提交格式：`<type>(<scope>): <subject>`，type ∈ `feat`/`fix`/`refactor`/`test`/`docs`/`chore`；subject 可中文，≤50 字符，不加句号；正文解释 why
- 原子提交：一次提交只做一件逻辑完整的事；格式化与逻辑、重构与功能分开提交
- 分支：`feature/` `fix/` `chore/` `refactor/` 前缀，短命分支（1-3 天），main 始终可部署
- 提交前：`git status` + 完整 `git diff` 自查 → 查密钥（password/secret/api_key/token）→ 跑测试与类型检查

## 对外声明（写进 README，改动需同步）

README 的「覆盖边界」与「能力声明」两节是事实陈述，不是免责条款。改写时保持陈述语气（"插件判定 X"、"插件不读取 Y"），不要退化成"不承担任何责任"式的法律话术——那既不增加信息，又让人读不出真实边界。

七条事实：

1. 插件判定的是"收尾时有没有调用过 `target_status`"；任务是否真的完成由模型判断。模型在未完成时声明 `done`，插件放行。
2. 注入是提醒，不是命令。模型可以忽略它继续收尾；同一轮会再次注入，不设硬上限（第 5 次向用户发一次提示）。
3. 判定依据是宿主事件（`agent/turn-stopping`、`agent/assistant-stream`），按 `0.2.1-rc.5` 的契约实现。
4. 用户取消轮次后不再注入，也不复活该轮；下一次用户输入恢复门控。
5. 留痕是旁路：写盘失败时插件继续判定与注入，只告警一次。
6. **上游断流按错误码区别对待。** 单次失败由宿主 `agent/request-error` 重试；重试耗尽后轮次以 `error` 结束，宿主**不派发** `agent/turn-stopping`（`dsh-agent-loop/lib/index.js:1001` 在正常收尾路径内）。插件在 `agent/error` 上补轮次级恢复：可重试码（`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`）自动续行，默认上限 3 次、正常收尾清零；`AUTH`/`QUOTA`/`CONTEXT_WINDOW_EXCEEDED` 不续行。**取消路径不派发 `agent/error`**（`index.js:1010-1016` 命中 abort 分支直接 throw），相关判断是防御性的。

7. **初始注入可关闭，关闭即整体退出。** `declarationSection` 为 `false` 时，章节、`target_status`、收尾门、上游续行四者一起停——没有声明通道时保留门禁，只会无限催促一个模型无法满足的条件。该开关决定注册行为，按启动时取值；`enabled` 等其余开关仍即时生效。

**开销**（README「开销」节有实测数字）：系统提示词章节 433 字符/轮；提醒 647 字符/次；复述 306 字符，每累计 3 次遗忘出现一次。上游续行的代价是**一整轮上下文重发**，因此有 3 次上限。真实成本是"可能多一轮"，实测注入响应中位数约 9.6 秒。

许可为 MIT（`LICENSE` 全文）；`package.json` 的 `license` 字段、`files` 收录与 README 许可节三处必须一致。

## 安全红线

- 禁止提交密钥、token、`.env*`；禁止在日志中记录会话内容或用户数据
- 边界校验所有宿主输入；不得信任未校验的事件 payload
- 不修改宿主安装目录；需要的行为通过插件实现
- 插件不得静默改变用户的权限、模型或 provider 配置

## 质量门

- 没有失败的测试就不写生产代码（TDD 铁律）
- 不审查不合并：五轴审查（正确性/可读性/架构/安全/性能），三级标注（[必须修复]/[建议修改]/[仅供参考]）
- 触碰提示词注入、轮次边界、重试策略的变更，必须补回归测试并过安全轴
- 详细原则见 `.specify/memory/constitution.md`
