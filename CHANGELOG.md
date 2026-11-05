# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 收尾提醒与声明规范改为干练、机械的注入式措辞。提醒首段只给"继续工作"指令，不再描述"你未声明就收尾"——把收尾诊断成失误会诱发模型在后续回避中断，分散注意力；本项目维持推进，不纠正模型。系统提示词章节 324 字符、注入提醒 409 字符（截断版 489）、复述 251 字符（原 433 / 647 / 306）。`tests/unit/prompt.test.ts` 断言提醒以"继续"开场且不含诊断措辞；`tests/integration/reminder.test.ts` 的复述断言改为大小写不敏感。

## [0.4.2] - 2026-11-05

### Fixed

- **设置分区打开后一片空白**：客户端只注入了 `remote`，而 `ctx.remote` 是 typert 的远程代理，属性有独立访问门；渲染时读 `remote.settings` 抛出 `cannot get property "remote.settings" without inject`，宿主把整条 section 判为崩溃并撤下（导航项还在，内容区空）。现声明为 `inject = ['remote', 'remote.settings', 'slots']`，并加了两条针对产物 `inject` 与分区注册的回归测试——这个错误类型检查发现不了，只有真机渲染才暴露。
- **`stallNoticeThreshold` 在设置页里读不到也写不进**：宿主只把 `.volatile()` 字段交给设置文档，该字段此前不是 volatile，`SettingsNamespaceView.value` 里根本没有这个键。现改为 volatile，八个字段全部可见可写。
- **同一轮被无限重复注入**：守护进程的幂等缓存把 `turn-stopping` 也缓存了（键 `session:turn:type`）。门注入后宿主会再跑一步、同一轮再次收尾，第二次请求命中缓存又拿到 `inject: true`——注入、再注入，停不下来；而且缓存短路发生在分发之前，**连留痕都不写**，所以现场表现为"每轮都收到同一条 `attempt 1` 提醒、留痕文件零新增"。现改为只缓存副作用请求（`turn-start` / `declare` / `finish` / `dispose`），判定类请求一律重新执行。

### Changed

- 设置分区的命名空间识别改为先按条目 id（`target-monitor`）精确匹配，特征字段只作兜底——实测 `value` 可能缺键，不能拿字段存在性当唯一判据。

## [0.4.0] - 2026-11-05

### Added

- **设置界面改由客户端插件接管**（spec 008）：注册 `settings.section` 分区，把八个配置字段与「关闭初始注入后的 AGENTS.md 建议」放在同一页，写回走 `settings.update` 并带 revision 做冲突检测。此前只有宿主按 volatile 字段自动生成的表单，承载不了建议文案与复制按钮。
- **两个复制按钮**：关闭初始注入后，可一键复制规范正文或写进用户级 `AGENTS.md` 的片段。文本在构建期从宿主侧常量注入客户端产物，不另存一份，避免两处漂移。
- `declarationSection` 配置项（默认 `true`）：关闭后不注册系统提示词章节、不注册 `target_status`，收尾门与上游续行一并停用。

### Changed

- 构建链新增一步：`tsc` 编出 CommonJS 客户端代码后，由 `scripts/build-client.mjs` 套上宿主要求的 `window.__ModuleLoader__.load` 包装。**未引入 bundler**——客户端保持单文件，脚本会在产物含相对 `require` 时直接报错。
- `npm run build` 与 `npm run typecheck` 现在都覆盖客户端工程。

### Notes

- `declarationSection` 决定的是注册行为，无法在运行中撤销，因此按启动时的取值生效，改动需重启；`enabled` 等其余开关仍即时生效。
- 关闭初始注入后若仍希望模型声明状态，需要把设置页给出的片段写进用户级 `AGENTS.md`——插件不再替用户注入。


## [0.3.0] - 2026-11-05

### Added

- 跨进程守护：判定状态与留痕写入集中到一个独立进程，多个 DSH 入口共享同一份遗忘与续行计数，留痕不再有并发交错（spec 007）。
- `crossProcess` 配置项：可强制退回进程内判定。

### Changed

- `agent/turn-stopping` 监听器在跨进程模式下改为异步，依赖宿主 `dispatch.serial` 的 await；进程内模式仍同步注入。


## [0.2.0] - 2026-11-05

### Added

- **上游异常自动续行**（spec 006）：监听 `agent/error`，对可重试错误码（`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`，与宿主默认白名单一致）在轮次真正 idle 之后投递一条自救提醒，自动开启新一轮。此前上游抖动的重试耗尽后，任务会停在半路且没有任何补救——因为 `agent/turn-stopping` 只在正常收尾路径派发。
- **两个 volatile 配置项**：`resumeOnUpstreamError`（默认 `true`）与 `maxResumes`（默认 `3`，`0` 等价于关闭）。二者在设置页可见，改动即时生效。
- **三类新留痕**：`upstream-resumed` / `upstream-skipped` / `upstream-capped`，并新增可选字段 `errorCode`。`outcome` 仍只有 `injected` / `released` 两值，既有 `jq` 查询无需修改。

### Changed

- 定位重述：本项目治理的是**实际使用中的任务中断**，而不是单一的"模型以为说完了"。思考泄露、工具调用畸形、模型自认完成在本插件眼里是同一件事——轮次在没有任何目标状态声明的情况下结束。README 的「背景」与「覆盖边界」按此重写。
- 上游断流/限流从「部分覆盖」改为「已覆盖（重试层之后）」：单次失败仍由宿主 `agent/request-error` 重试，插件只在重试耗尽后补一次轮次级恢复，不重复实现退避策略。

### Fixed

- 无。

### Notes

- 续行的代价是一整轮上下文重发，因此默认上限为 3 次；正常收尾（`stop` / `tool-calls` / `max-tokens`）即清零。
- 取消路径不会触发 `agent/error`（宿主的 catch 命中 abort 分支后直接抛出），因此「取消不续行」是防御性约束，相关测试为单元级防御断言。

## [0.1.0] - 2026-11-05

首个正式发布。此前 22 个提交为开发期提交，不单独成版。

### Added

- **收尾门**：轮次关闭前检查目标状态声明，未声明则注入自救提醒并让轮次继续。
- **`target_status` 工具**：`done` / `awaiting_user` 两种声明，作为唯一判定依据。
- **两种结束原因**：区分普通收尾与 `max-tokens` 截断，后者说明截断后的工具调用未执行。
- **卡住提示**：同一轮第 5 次未声明时向用户提示一次，阈值可配置。
- **跨轮复述**（spec 005）：按 agent 累计"遗忘"次数（注入后 30 秒内声明计一次），达阈值后下一次提醒追加声明规范复述，发完清零。真中断不计数也不清零。
- **判定留痕**（spec 004）：每次判定写一条 JSONL（`~/.dsh/logs/target-monitor/gate-trace.jsonl`），放行也记，六种原因可区分；单文件超 2 MiB 轮转，保留两代。
- **设置页**：`enabled` / `reminderThreshold` / `reactionWindowMs` 声明为 volatile，改动即时生效。
- **三种安装方式**：bundle（`dsh.manifestVersion` + `dsh.bundle.patch`）、git 源、本地 link。
- **MIT 许可**：补齐 `LICENSE` 全文，`package.json` 与分发文件一致。

### Fixed

- **配置二次校验导致插件整条 entry inactive**：宿主先用插件导出的 `Config` 解析配置，`apply` 又跑了一遍 schema，volatile 的 `enabled` 被当作布尔值校验。改为先识别"已解析"形态再复核数值。
- **声明写到错误的轮次键**（spec 002）：轮次只在 `turn-stopping`（轮次结束时）写入，工具却在轮次中途读取，导致一轮里的首次声明落到上一轮。写入点前移到 `assistant-stream` 的 `start` 帧。
- **系统提示词章节序号撞号**：`SECTION_ORDER` 曾为 900，与宿主 `FILE_REFERENCE` 撞号，章节被排进 `AGENTS.md` 正文中间。改为 2500（goal 段之后、workflow 段之前）。
- **工具返回值暴露轮次**：`target_status` 曾返回 `turn`，诱导模型推理轮次编号。改为只返回 `{ ok, state }`。
- **测试污染真实日志目录**：集成测试驱动真实 `apply` 时会把假记录写进 `~/.dsh/logs/`。改为在 `node --test` 进程内默认不落盘。

### Changed

- 系统提示词中的声明协议改为"先声明，再汇报 / 先声明，再提问"的顺序表述——只说"收尾前要声明"时，模型倾向于先写完汇报再补声明，那时轮次已经要关闭。

[Unreleased]: https://github.com/FirenzeClaw/dsh-Target-achieved/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/FirenzeClaw/dsh-Target-achieved/releases/tag/v0.1.0
