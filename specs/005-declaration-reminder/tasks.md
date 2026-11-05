# Tasks: 声明规范复述

**Feature**: 005-declaration-reminder · **Input**: plan.md / spec.md / data-model.md / contracts/

## Phase 1: Setup

- [x] T001 从 `specs/005-declaration-reminder/plan.md` 确认改动面：新增 `src/forget.ts`，改 `config.ts` / `gate.ts` / `tool.ts` / `prompt.ts` / `index.ts`

## Phase 2: Foundational

- [x] T002 [P] 在 `src/config.ts` 新增 `reminderThreshold`（默认 3）与 `reactionWindowMs`（默认 30000），两者 `.volatile()`
- [x] T003 在 `src/config.ts` 把 `assertThreshold` 泛化为 `assertPositiveInt(value, field, fallback)`，错误信息带字段名
- [x] T004 在 `src/config.ts` 新增 `assertVolatilePositiveInt`，覆盖"已解析配置里 volatile 数值非法"的路径
- [x] T005 在 `src/config.ts` 原始配置路径补上三个阈值的独立校验（`z.number()` 放行 0，schema 不是边界）

## Phase 3: US1（P1）— 达到阈值后复述

- [x] T006 [P] [US1] 新建 `tests/unit/forget.test.ts`，按契约 C-001…C-010 写 10 条用例（先红）
- [x] T007 [US1] 新建 `src/forget.ts`：`noteInjection` / `noteDeclaration` / `takeReminderDue` / `forgetForgetful`
- [x] T008 [P] [US1] 在 `src/prompt.ts` 新增 `REMINDER_TEXT` 常量（先声明再汇报/等待两条 + 后果说明）
- [x] T009 [US1] 在 `src/gate.ts` 注入前登记 `noteInjection`，组装正文时按 `takeReminderDue` 追加复述
- [x] T010 [P] [US1] 新建 `tests/integration/reminder.test.ts`，用假 ctx 驱动真实 `apply`，断言第四次注入含复述

## Phase 4: US2（P1）— 声明计入计数

- [x] T011 [US2] 在 `src/tool.ts` 给 `registerTargetStatus` 增加 `onDeclared` 回调，声明成功后调用
- [x] T012 [US2] 在 `src/index.ts` 接线 `onDeclared` → `noteDeclaration(agent, Date.now(), config.reactionWindowMs.get())`
- [x] T013 [US2] 在 `src/index.ts` 的 `agent/disposed` 里调用 `forgetForgetful`
- [x] T014 [US2] 集成用例：声明被拒绝（非顶层 / 无轮次）不推进计数

## Phase 5: Polish

- [x] T015 反向验证：注释掉 `onDeclared` 接线后复述用例必须失败（实测 4 条失败）
- [x] T016 集成用例：复述段与 `REMINDER_TEXT` 逐字相同，不得拼接运行时数据
- [x] T017 全量回归：`npm test` 73 项通过、`npm run typecheck`、`npm run build`
- [x] T018 更新 `specs/005-declaration-reminder/contracts/reminder.text.md` 的插入位置描述与实际实现一致

## 依赖关系

```text
T002 → T003 → T004 → T005
                  ↓
T006 → T007 → T009 → T010
         T008 ↗
T007 → T011 → T012 → T014
T013 独立
```

## 判据

- 复述只在"累计遗忘达到阈值后的下一次注入"出现一次，随即清零。
- 真中断（注入后始终没声明）不计数、也不清零。
- 关掉 `enabled` 时不注入，因此也不推进计数。
