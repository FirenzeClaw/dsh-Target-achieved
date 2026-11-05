# Tasks: 初始注入开关与设置界面接管

**Feature**: `specs/008-prompt-optout` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Phase 1: Setup

- [x] T001 建客户端独立工程 `tsconfig.client.json`（CommonJS，仅 `src/client`）
- [x] T002 写 `src/client/shims.d.ts`：React 四个 hook 与 `jsx`/`jsxs`，加 `navigator.clipboard`、`window.setTimeout`
- [x] T003 写 `scripts/build-client.mjs`：套 ModuleLoader 包装、注入规范正文、拒绝相对 require

## Phase 2: Foundational

- [x] T004 `package.json` 加 `dsh.client.platform`、`exports["./client"]`、`files` 收录脚本
- [x] T005 `build` 与 `typecheck` 脚本覆盖两个工程
- [x] T006 `tests/unit/client-build.test.ts`：包装形状、id、无相对 require、正文与宿主常量一致

## Phase 3: US1 关闭初始注入后完全静默（P1）

- [x] T007 `tests/integration/section-off.test.ts`：不注册章节、不注册工具、门不注入、续行不投递、默认配置下三者照常
- [x] T008 `src/index.ts` 加 `sectionEnabled` 守卫，包住章节与工具注册
- [x] T009 门监听器在 `sectionEnabled` 为假时直接返回
- [x] T010 `scheduleResume` 在 `sectionEnabled` 为假时直接返回
- [x] T011 `src/config.ts` 提供 `declarationSection`（volatile，默认 true）

## Phase 4: US2 设置界面全量接管（P2）

- [x] T012 `src/client/index.ts`：字段表（八项）、`FieldSpec`、`findNamespace` 按特征字段识别
- [x] T013 分区组件：加载态、错误态、只读态、字段渲染
- [x] T014 写回：`settings.update(ns, patch, revision)`，成功后用返回值刷新快照
- [x] T015 冲突与失败提示（含 `SETTINGS_CONFLICT` 专有文案）
- [x] T016 `apply(ctx)` 注册 `settings.section`（id `target-monitor`，order 60）

## Phase 5: US3 替代方案与复制（P3）

- [x] T017 `declarationSection` 为假时展示 AGENTS.md 建议与片段全文
- [x] T018 两个复制按钮（规范正文 / AGENTS.md 片段），带「已复制」反馈

## Phase 6: 验证与收尾

- [x] T019 `npm run typecheck`（两个工程）通过
- [x] T020 `npm run build` 产出 `dist/client.js`（11 518 字节）
- [x] T021 `npm test` 191 项全通过
- [x] T022 真实实例 `dsh web --port 3097` 启动无 `entry did not activate`、无 `missing bundle`
- [x] T023 确认宿主把本插件编进启动图：组合脚本内含 `id: "dsh-target-monitor"` 与 `settings.section`
- [ ] T024 在浏览器里实际打开「设置 → 目标监测」并逐项操作（需人工或设备自动化）
- [ ] T025 验证复制按钮在真实剪贴板下的行为

## 依赖

US1 与 US2/US3 相互独立：前者是服务端守卫，后者是客户端分区。T007 必须先于 T008–T010（红→绿）。

## 未完成说明

T024/T025 需要真实浏览器交互，本会话未做。当前已证到"宿主收录并服务该 bundle"，未证到"分区渲染正确"。
