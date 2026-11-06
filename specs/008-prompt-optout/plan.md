# Implementation Plan: 初始注入开关与设置界面接管

**Feature**: `specs/008-prompt-optout` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

## Summary

两件事：给初始注入一个开关，并把设置界面从宿主自动表单换成插件自带的客户端分区。

开关只管"要不要在会话开始时自动注入规范"。**v0.5 修订**：早期实现连带停用了 `target_status`、收尾门与上游续行，理由是"只关章节而留着门，门会催促一个没有通道的条件"——但关掉该开关的真实场景是"改用 AGENTS.md 承载规范"，模型仍有通道，门也就仍有可满足的条件。因此现在只停系统提示词章节。

设置界面必须自己渲染，因为自动表单只能生成输入框，承载不了"关闭初始注入后该怎么办"的说明与复制按钮。

## Technical Context

- **语言/运行时**：TypeScript 5.9.3 + Node 24（服务端）；浏览器端为宿主模块表提供的 React
- **插件模型**：cordis `~4.0.5`；服务端导出 `apply(ctx, config)`，客户端导出 `apply(ctx)` + `inject`
- **宿主版本**：DeepSeek-Harness `0.2.1-rc.5`
- **配置读写**：服务端 `volatile` 字段即时生效；客户端经 `ctx.remote.settings.describe()` / `update(ns, patch, revision)`
- **测试**：`node --test`（Node 原生类型剥离），无框架依赖
- **构建**：`tsc` 两遍 + 一个包装脚本；**不引入 bundler**（见 research.md）

## Constitution Check

| 原则 | 本特性的取舍 |
|---|---|
| I 判定只认工具调用 | 关闭注入即关闭工具，判定不再有输入源——一致，不是例外 |
| II 注入必须带来源与原因 | 客户端分区不产生注入，只改配置，不触碰该原则 |
| III 文案不得拼接运行时数据 | 复制的规范正文与 AGENTS.md 片段均为常量，构建期注入 |
| IV 用户取消不得复活 | 开关不影响取消语义 |
| V 不留会话内容 | 设置页只读写配置，不记录会话 |

无违规项，无需豁免。

## Phase 0：研究（见 research.md）

三个未知项已解决：客户端 bundle 的产物格式、配置写回接口、字段清单与自动表单的关系。

## Phase 1：设计

### 数据模型

见 [data-model.md](./data-model.md)：`ClientConfigView`（分区读到的配置快照）、`FieldSpec`（字段描述）、`CopyTarget`（复制目标）。

### 接口契约

- [contracts/settings-panel.md](./contracts/settings-panel.md)：分区渲染、写回、冲突、只读、复制五类行为
- [contracts/client-bundle.md](./contracts/client-bundle.md)：客户端产物的格式与构建约束

### 关键结构

```
src/client/index.ts      # 单文件：字段表 + 分区组件 + apply
src/client/shims.d.ts    # React 与浏览器全局的最小声明（不引入 @types/react）
scripts/build-client.mjs # tsc 的 CJS 产物 → ModuleLoader 包装；注入规范正文；拒绝相对 require
tsconfig.client.json     # 客户端独立工程（CommonJS）
```

服务端改动只有 `src/index.ts` 的一处守卫：`sectionEnabled` 决定注册与两处投递。

### 构建顺序

1. `tsc -p tsconfig.json` → `dist/`（服务端，含 `dist/prompt.js`）
2. `tsc -p tsconfig.client.json` → `dist/client-raw/index.js`（CommonJS）
3. `node scripts/build-client.mjs` → `dist/client.js`

第 3 步从 `dist/prompt.js` 读 `DECLARATION_SECTION`，因此**必须先跑第 1 步**——这保证了复制文本与真实注入逐字一致（FR-015）。

## Phase 2：任务

见 [tasks.md](./tasks.md)。

## 风险与取舍

| 风险 | 处置 |
|---|---|
| 客户端产物格式与宿主契约不符 → 启动即失败 | `tests/unit/client-build.test.ts` 直接对 `dist/client.js` 断言包装、id、无相对 require；真实实例验证启动无 `missing bundle` |
| 客户端与宿主共用 React 实例的假设不成立 | 宿主模块表由 shell 冻结，`require("react")` 解析到同一份；若将来不成立，表现为 hooks 报错而非静默错误 |
| `declarationSection` 是 volatile 但注册是静态的 | 按启动时取值，README 与分区说明均写明"需重启" **v0.5 修订**：门与续行不再随之停用，它们只受 `enabled` 影响 |
| 客户端代码无法拆文件 | 单文件约束由 `build-client.mjs` 强制；当前规模（约 400 行）尚可维护，超过则改用 bundler |

## 未覆盖

- 分区内的本地化：当前文案为中文，未接入宿主 `locale` 服务。多语言需求出现时再补。
- 复制失败时的"可选中文本"兜底（FR-016）只做了 `<pre>` 常驻展示，未做剪贴板失败的显式降级提示。
