# Research: 初始注入开关与设置界面接管

## R-001 客户端产物必须是什么格式

**Decision**：`window.__ModuleLoader__.load({ id, factory: (require) => { ... } })` 包装的 CommonJS，依赖经裸模块名 `require` 取。

**Rationale**：宿主只服务**已构建**的客户端 bundle（`dsh-client-modules/README.md`「Build requirements」），缺文件会**启动即失败**。实测 `dsh-api-remote-access/lib/client.js` 与 `billion-context` 的产物开头逐字一致，工厂内是 CommonJS。

**Alternatives**：直接交付 ESM——不可行，宿主没有 ESM 加载路径。

## R-002 是否引入 bundler

**Decision**：不引入。`tsc` 输出 CommonJS，再由 `scripts/build-client.mjs` 套包装。

**Rationale**：本项目构建只有 `tsc`，加 bundler 会带来一份配置与一个依赖。客户端只有单文件，包装是纯字符串拼接，约 20 行。

**Alternatives**：esbuild / tsdown——与宿主一致，能拆文件、能 JSX；代价是新增依赖与构建配置。若客户端规模增长到需要拆文件，再切换。

**约束**：客户端不得有相对 import，否则 tsc 会产出 `require("./x")`，宿主模块表解析不了。`build-client.mjs` 在检测到相对 require 时直接抛错，把这条约束变成构建期错误而不是运行期谜题。

## R-003 设置写回走哪条通道

**Decision**：客户端 `ctx.remote.settings.describe()` 读取，`update(ns, patch, expectedRevision)` 写回。

**Rationale**：`dsh-api-settings-controller/lib/typert.remote-client.d.ts` 暴露了 `settings/describe`、`settings/update`、`settings/replace`；`describe()` 返回 `{ writable, hasDocument, namespaces[] }`，每个命名空间带 `value`、`user`、`revision`。写回带 revision 即可做冲突检测（`SettingsConflictError`，`code = "SETTINGS_CONFLICT"`）。

**Alternatives**：自己开 HTTP 路由——多一套写通道与鉴权，且绕过宿主的 revision 语义。

## R-004 如何认出本插件的命名空间

**Decision**：按特征字段识别（`value` 里有 `stallNoticeThreshold`），不按条目 id 拼写。

**Rationale**：命名空间名来自 profile 条目，用户可自行改名；特征字段由 `Config` schema 决定，稳定得多。

**Alternatives**：硬编码 `target-monitor`——改名即失效。

## R-005 复制文本从哪里来

**Decision**：构建期从 `dist/prompt.js` 读 `DECLARATION_SECTION` 注入客户端产物。

**Rationale**：FR-015 要求复制内容与插件实际使用的文本逐字一致。让客户端另存一份必然漂移；运行期向宿主请求又需要新接口。

**Alternatives**：客户端硬编码 + 单测比对——测试能发现漂移，但要求客户端文件可被 Node 导入，而它依赖 React，反而引入测试环境问题。

## R-006 React 与类型

**Decision**：不安装 `@types/react`，在 `src/client/shims.d.ts` 里声明用到的最小面（`useState`/`useEffect`/`useMemo`/`useRef`、`jsx`/`jsxs`）。

**Rationale**：客户端不参与 Node 侧构建，`@types/react` 只为类型存在；本文件用到的 API 只有四个 hook 与两个工厂，手写声明更小也更明确。同时不开 DOM lib，只声明 `navigator.clipboard` 与 `window.setTimeout`。

**Alternatives**：加 `@types/react` devDependency——更省事，但把 React 版本假设带进构建，且与"客户端依赖由宿主提供"的事实不符。

## R-007 关闭开关后门与续行为何必须一起停

**Decision**：`declarationSection === false` 时，章节、工具、收尾门、上游续行四者一起停。

**Rationale**：门与续行的正文都是"去声明"。没有工具时，模型无法满足，门只会无限催促——这比不注入更糟。FR-004/FR-005 即此。

**Alternatives**：只停章节——已被否，理由同上。
