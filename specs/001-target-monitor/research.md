# Phase 0 Research: 目标达成监测器

**Feature**: `001-target-monitor` | **Date**: 2026-11-05

本文件记录实现前的技术决策。每条给出决定、理由与被否决的替代方案；宿主侧证据均来自 `@deepseek-ai/dsh@0.2.1-rc.5` 的发布产物（`lib/` 与 `lib/types/`）。

## D1. 拦截点：`agent/turn-stopping`

- **Decision**: 在 `agent/turn-stopping`（serial、awaited）里判定是否放行，需要继续时调用 `agent.steer()`。
- **Rationale**: 这是宿主唯一的"轮次即将关闭但尚未关闭"点。监听器 steer 后，循环重读收件箱并再走一步，同一轮内完成续行，用户看到一个连续推进的轮次而不是"结束后又被补一条"。证据：`dsh-agent-loop/lib/index.js:1000-1006`。
- **Alternatives considered**:
  - *轮次结束后再注入*（`agent/status` 转 idle 时 followup）：会开新轮次，用户看到两段对话；且与 `goal-round-driver` 的 idle 续行直接竞争。
  - *`agent/request-error` 里接管*：只覆盖请求失败，覆盖不到"正常结束但任务没做完"，且宿主已有重试策略，接管会双重。
  - *在 `agent/pre-step` 拒绝步骤*：只能拦截进入步骤的输入，无法在收尾处判断。

## D2. 声明方式：模型工具 + 静态系统提示词章节

- **Decision**: 注册 `target_status` 工具负责声明；规范文本用 `ctx.systemPrompt.section()` 静态注册一次。
- **Rationale**: 工具调用是结构化、可归属、可回放的信号，不依赖解析自然语言（FR-014）。静态章节属于请求前缀，不逐轮追加，KV cache 友好；且不受压缩影响。
- **Alternatives considered**:
  - *每轮注入一条用户消息写规范*（用户原案）：重复污染历史、每轮破坏前缀缓存、压缩后语义可能丢失。
  - *让模型在正文里写 "DONE" 再由插件匹配*：解析自然语言，违反 FR-014，且截断时最该识别却最不可靠。
  - *复用 `dsh-goal`*：`create_goal` 需人类直接请求，且面向多轮自主推进，语义过重（详见设计文档 §3.6）。

## D3. 状态作用域：内存中的 (agent, turn)

- **Decision**: 每个顶层 agent 每个轮次一份状态，只存内存，轮次号变化即失效。
- **Rationale**: 满足 FR-003（每轮默认"进行中"）且不需要"重置"代码；resume/fork 后从"进行中"开始，方向安全（宁可多问一次）。宿主同样以内存 `WeakMap<Agent, ...>` 管理类似状态（`dsh-repeat-tool-reminder`）。
- **Alternatives considered**:
  - *持久化到会话事件*：需要新增 session 事件与投影，远超本特性需要；且跨轮语义应由 `dsh-goal` 承担。
  - *按会话存一份*：模型提前声明后会跨轮生效，导致漏判。

## D4. 原因分类：`FinishReason`

- **Decision**: 用 `stop` / `tool-calls` / `max-tokens` / `aborted` / `error` 分类，只区分"截断"与"其他"。
- **Rationale**: 宿主已把结束原因结构化，经 `agent/assistant-stream` 的 `finish` 块可达（`dsh-llm/lib/types/types.d.ts:131-151,440-458`）。`max-tokens` 时 `BlockAssembler` 会丢弃无法执行的工具调用（`dsh-llm/lib/types/assembler.d.ts:45`），提醒必须说明这点，否则模型会以为调用已成功。
- **Alternatives considered**:
  - *按消息文本是否以句号/问号结尾猜测*：不可靠。
  - *逐类定制文案（error/aborted 单独处理）*：`aborted`/`error` 在收尾门之前就已抛错，根本到不了本钩子（`dsh-agent-loop/lib/index.js:1131-1143` 先走 `request-error`，失败即抛）。

## D5. 投递方式：`agent.steer()`

- **Decision**: 在收尾门内用 `agent.steer(message)` 追加一条用户角色消息。
- **Rationale**: `steer` 明确用于"让机器再跑一步"；`inject` 只在下一次 pre-step 被领取，若当前轮即将关闭则可能整轮丢失。
- **Alternatives considered**:
  - *`agent.inject()`*：不唤醒、可能错过本轮的最后一个 pre-step。
  - *`agent.followup()`*：开新轮次，改变用户可见的对话结构。

## D6. 消息来源：插件自有 kind，不用 `user`

- **Decision**: 声明 `MessageSourceMap` 的 `target-monitor` kind，并带 `form: 'notice'` 与 `summary`。
- **Rationale**: 宿主明确说明来源类型是 merge-extensible、"没有共享的 plugin 兜底 kind"（`dsh-llm/lib/types/message.d.ts:97-110`）；`goal` 就是这么做的（`dsh-goal/lib/types/domain.d.ts:34-46`）。用 `user` 会让注入在日志与权限判定层面冒充人类输入——这正是要避免的。
- **Alternatives considered**:
  - *用 `kind: 'user'`*：会与"人类直接请求"的权限判定混淆（`dsh-tool-goal/lib/index.js:44-52` 正是靠 `source.kind === 'user'` 认定人类授权），属安全缺陷。

## D7. 测试框架：`node --test` + 原生类型剥离

- **Decision**: 用 Node 内置 test runner，直接跑 `.ts`，不引入 vitest/jest。
- **Rationale**: 实测通过（Node 24.22.1，两个用例，0 依赖）。项目是纯逻辑判定，不需要 DOM/快照/覆盖率生态；少一层依赖 = 少一处版本漂移。
- **Alternatives considered**:
  - *vitest*：功能更全（watch、覆盖率、mock），但为一个 5 文件的插件引入一整套工具链。
  - *jest + ts-jest*：ESM 配置成本高，收益为负。

## D8. 构建：`tsc` 直出 ESM

- **Decision**: `tsc -p tsconfig.json` 输出 `dist/`，`package.json` 的 `exports` 指向 `dist/index.js` 与 `.d.ts`。
- **Rationale**: 无打包需求（包体小、无浏览器目标、依赖由宿主提供）。`tsc` 同时承担类型检查（`--noEmit` 可单独跑）。
- **Alternatives considered**:
  - *tsup / esbuild*：打包速度优势在单包小体量上无意义，还会引入 bundler 配置与 sourcemap 取舍。
  - *直接发布 `.ts` 让宿主跑*：依赖宿主的类型剥离行为，且对使用者不友好。

## D9. 开发期类型解析：链接宿主已安装包

- **Decision**: `scripts/link-host.sh` 把宿主的 `node_modules/@deepseek-ai` 链接到本仓库 `node_modules/`，路径可用 `DSH_INSTALL_DIR` 覆盖；`package.json` 里这些包声明为 `peerDependencies`。
- **Rationale**: 宿主包已在机器上（`~/.nvm/.../dsh/node_modules/@deepseek-ai/`），无需联网拉取 `0.2.1-rc.5` 的整棵依赖树；peer 语义也符合"插件由宿主提供运行时"的事实。宪法 §宿主集成约束要求用 peerDependencies。
- **Alternatives considered**:
  - *`pnpm add -D @deepseek-ai/...`*：需要 registry 可达，且会为类型检查拉入大量运行时包。
  - *tsconfig `paths` 指向绝对路径*：不可移植，换机器即坏。

## 未决但已有处理方式

| 事项 | 处理 |
|---|---|
| `concludesTurn` 结束的轮次（finish 为 `tool-calls`）是否算等价声明 | 先按"未声明"处理（会催一次）。实现 M1 时用 `present` 工具实测；若确认其语义是"主动完成"，在 M2 补豁免 |
| 轮次内 goal 转为 complete/blocked 的时序 | 先在 M3 用假事件验证；若时序不可靠，退化为"多催一次"，不影响正确性 |
| 宿主事件/服务缺失时的 fail-loud 方式 | `apply` 启动时校验 `agents` / `tools` / `systemPrompt` 服务与事件可用性；缺失则抛出带明确信息的错误（FR-015） |
