# Phase 0 Research: 可观测性与可分发

**Feature**: 004-observability-and-packaging · **Date**: 2026-11-05

## 决策 1：记录写入 JSONL 文件，不新增工具

**Decision**: 判定记录追加到 `$DSH_HOME/logs/target-monitor/gate-trace.jsonl`，同时保留内存环形缓冲供测试读取。

**Rationale**: FR-003 禁止记录进入模型可见面。工具结果必然进模型上下文，所以**不能**提供 `target_status_trace` 之类的查询工具。文件 + grep 同时满足 FR-004（按轮次检索）与 FR-003（不进模型面）。

**Alternatives considered**:
- 新增查询工具 —— 直接违反 FR-003。放弃。
- 复用系统提示词 / 注入通道回显 —— 同罪。放弃。
- SQLite —— 零依赖原则与规模都不需要。放弃。

**已验证**：`~/.dsh/logs/` 已是宿主既有日志目录（`dsh-web-3080.log`、`startup-*.log`），`dsh-home-paths/lib/index.js:15` 定义 `DSH_HOME_ENV = "DSH_HOME"`，说明该路径解析方式与宿主一致。

## 决策 2：记录粒度是"每次判定"，不是"每次注入"

**Decision**: 放行也要记一条，并带 `reason`。

**Rationale**: 用户此前的困惑正是"这一轮到底有没有判定"。只记注入无法回答，反而会让人以为插件没运行（003 号误判就是这么产生的）。同时 `reason` 要能区分六种出口，才能替代"翻会话日志猜"。

**Alternatives considered**:
- 只记注入 —— 无法证伪"没运行"。放弃。

## 决策 3：会话标识用短哈希

**Decision**: `session` 字段取 agent 标识的 8 位十六进制哈希。

**Rationale**: FR-006 要能区分不同 agent；但宪法安全红线禁止记录会话内容或用户数据。哈希既满足区分，又不落原文。

**Alternatives considered**:
- 直接记 sessionId —— 可用但更长，且与本项目的"不落用户数据"倾向不符。哈希更保守。
- 不记 —— 无法区分并发会话。放弃。

## 决策 4：保留策略是文件轮转，不是按条数裁剪

**Decision**: 单文件超 2 MiB 时改名为 `.1`，最多保留 2 个文件。

**Rationale**: 按条数裁剪需要每次写入前统计行数（读取整文件），代价高。文件大小可直接 `statSync` 得到，写入路径上只多一次 stat。

**Alternatives considered**:
- 内存环形缓冲上限 200 条 —— 已有，但只用于测试/调试，不能当持久保留（进程重启即失）。
- 按日期分文件 —— 需要判断跨天，且不利于按轮次 grep。

## 决策 5：写入失败只告警一次，不重试、不抛出

**Decision**: `recordTrace` 内部 try/catch，首次失败写一条内部标记（进程内布尔），后续静默。

**Rationale**: FR-007 要求留痕失败不影响判定。判定在 `turn-stopping` 里执行，抛错会打断轮次收尾——比丢日志严重得多。只告警一次避免磁盘满时刷屏。

## 决策 6：bundle 元数据按 `dsh-package-manifest` 的约定

**Decision**: `dsh.manifestVersion: 1` + `dsh.bundle.patch: "dsh.bundle.patch"` + `engines.dsh`。

**Rationale**: 已读 `dsh-package-manifest/README.md` 确认这是安装器识别 bundle 的唯一方式；当前包 `private: true` 且无这些字段，只能 `link:` 挂载（本项目的实际状态）。

**未决**：`dsh.bundle.patch` 的补丁内容需要与 profile 现有的 `cordis.patch.yml` 条目对齐——实现阶段以 profile 里已验证可用的 insert 条目为准。

## 决策 7：设置页零前端代码

**Decision**: 仅把字段声明为 `.volatile()`，不写客户端插件、不加页面。

**Rationale**: 已核实 `dsh-settings/lib/index.js:122` 的 `volatileForm(schema)` 会递归遍历 schema，把每个 volatile 节点放进表单；`lib/index.js:418` 在生成表单时调用它。README 也明确「Forms expose only volatile fields from active, uniquely addressed profile entries」。因此 FR-008 只需声明。

**风险**：该能力依赖插件在 profile 中被"唯一寻址"（uniquely addressed）。若同一 profile 里同一插件被挂两次，表单不出现。实现阶段在 quickstart 里写明这个前提。

## 决策 8：不改变判定语义

`trace.ts` 是纯旁路。`gate.ts` 的每个 return 前加一次 `recordTrace`，不参与任何条件判断。FR-016 由"既有 55 个测试全部不改"来保证。

## 决策 9：双通道发布

**Decision**: npm 与 git 同时发布，仓库 `git@github.com:FirenzeClaw/dsh-Target-achieved.git`（用户 2026-11-05 决定）。

**Rationale**: 市场清单 format 1 的 `MarketVersion.source` 只区分 `npm` 与 `git` 二选一，但两条通道可以各自带一个版本条目。同时发布让用户既能 `npm i` 也能 `dsh plugin add <git url>`；代价是发布流程要保证版本号与 commit 一一对应。

**Alternatives considered**:
- 只发 npm —— git 用户无法从源码装。放弃。
- 只发 git —— 无法享受 npm 的版本解析与缓存。放弃。

**代价**：每次发布要同时做 `npm publish` 与 `git push --follow-tags`，且 git 源的 `commit` 必须是 tag 指向的提交而不是分支 HEAD——否则同一版本号在某些时刻会指向不同代码。
