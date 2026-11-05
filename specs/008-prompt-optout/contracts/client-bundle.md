# Contract: 客户端产物

## C-101 格式

产物必须是：

```js
window.__ModuleLoader__.load({
  id: "<package name>",
  factory: (require) => { /* CommonJS */ return module.exports; }
});
```

## C-102 依赖

- 只允许裸模块名 `require`；相对路径会被宿主模块表拒绝。
- 当前仅依赖 `react` 与 `react/jsx-runtime`，均由宿主模块表提供。

## C-103 声明

`package.json` 必须含：

```json
{ "dsh": { "client": { "platform": "web" } }, "exports": { "./client": "./dist/client.js" } }
```

## C-104 构建

`npm run build` 必须产出 `dist/client.js`；缺失时宿主启动即报 `missing bundle`。

## C-105 常量注入

规范正文与 AGENTS.md 片段在构建期注入，来源为 `dist/prompt.js` 的 `DECLARATION_SECTION`；构建顺序因此不可颠倒。

## C-106 失败模式

| 破坏点 | 表现 |
|---|---|
| 缺 `dist/client.js` | 宿主启动失败，报缺 bundle |
| 产物含相对 require | 构建脚本报错（不是运行期） |
| 包装格式不符 | 启动图不收录该条目，分区不出现 |
