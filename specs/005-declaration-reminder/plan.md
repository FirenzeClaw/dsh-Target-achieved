# Implementation Plan: 声明规范复述

**Branch**: `005-declaration-reminder` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-declaration-reminder/spec.md`

## Summary

模型经常在收尾前忘记调用 `target_status`，被注入提醒后才补上。实测 8 次注入全部在 8–19 秒内被响应，说明多数注入并非"救活中断"，而是"拾遗遗忘"。

本特性按 agent 累计这种"遗忘"次数：注入后若在窗口内声明成功，计一次；真中断（窗口内没有声明）不计数也不清零。累计达阈值后，**下一次**注入在正文末尾追加一段规范复述，发完清零。

## Technical Context

**Language/Version**: TypeScript 5.9（ESM，Node 24）

**Primary Dependencies**: `@deepseek-ai/cordis ~4.0.5`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/schemastery`

**Storage**: 无持久化；计数存进程内 `WeakMap<Agent, ForgetState>`

**Testing**: `npm test`（`node --test`）

**Target Platform**: 宿主 DeepSeek-Harness 0.2.1-rc.5

**Project Type**: 单包 DSH 插件

**Performance Goals**: 每次判定 O(1)；不新增 I/O

**Constraints**: 不改变三种状态语义与注入预算；复述文案固定，不拼接运行时数据

**Scale/Scope**: 新增 1 个模块 `src/forget.ts`，改动 `config.ts` / `gate.ts` / `tool.ts` / `prompt.ts`，预计 < 120 行

## Constitution Check

| 原则 | 检查 | 结论 |
|---|---|---|
| I 简单性优先 | 一个 WeakMap + 三个函数，不引入定时器（窗口用调用时的时间差判断） | ✅ |
| II 测试先行 | 先写"三次遗忘后第四次注入含复述"的失败测试 | ✅ |
| III 提示面与状态安全 | 复述是固定文案，不拼接运行时数据；复用既有注入通道与来源归属 | ✅ |
| IV 原子提交 | 一个提交：机制 + 测试 + 文案 | ✅ |
| V 不审查不合并 | 触碰提示面，需过安全轴；含回归测试 | ✅ |
| VI 可读性与显式契约 | 计数语义（谁计数、谁清零）写成显式函数与注释 | ✅ |
| VII 复用宿主机制 | 不新增事件订阅；复用既有 `turn-stopping` 与工具执行路径 | ✅ |

**初判通过。**

## Project Structure

```text
specs/005-declaration-reminder/
├── spec.md
├── plan.md          # 本文件
├── research.md
├── data-model.md
├── contracts/
│   ├── reminder.text.md
│   └── forget-counter.md
├── checklists/requirements.md
└── tasks.md

src/
├── forget.ts    # 新增：per-agent 遗忘计数
├── prompt.ts    # 新增 REMINDER_TEXT 与 repairText 的可选提醒参数
├── gate.ts      # 注入时上报 noteInjection；按需拼接复述
├── tool.ts      # 声明成功时上报 noteDeclaration
└── config.ts    # 新增 reminderThreshold / reactionWindowMs（均 volatile）
```

**Structure Decision**: 沿用既有单包结构。计数逻辑独立成模块，避免把状态机塞进 `gate.ts`（后者已负责判定策略）。

## Phase 0: Research

见 [research.md](./research.md)。

## Phase 1: Design

- [data-model.md](./data-model.md)：计数状态与转换
- [contracts/forget-counter.md](./contracts/forget-counter.md)：何时计数、何时清零
- [contracts/reminder.text.md](./contracts/reminder.text.md)：复述文案与插入位置
- [quickstart.md](./quickstart.md)：可运行的验证步骤

### 变更点

1. **`src/forget.ts`（新增）**
   - `noteInjection(agent, now)`：记录本次注入时刻作为"待判定"标记；若已有未判定标记，说明上一次是慢响应 → 丢弃旧标记，不计数。
   - `noteDeclaration(agent, now, windowMs)`：存在待判定标记且 `now - at <= windowMs` 时计数 +1；无论是否命中都清除标记。返回当前计数。
   - `takeReminderDue(agent, threshold)`：计数达阈值时返回 `true` 并清零。
   - `forgetForgetful(agent)`：dispose 时清理。

2. **`src/gate.ts`**：注入前调用 `noteInjection`；组装文案时若 `takeReminderDue` 为真，在 `repairText` 之后追加复述段。

3. **`src/tool.ts`**：`declare` 成功后调用 `noteDeclaration`。

4. **`src/config.ts`**：新增两个 `.volatile()` 字段：
   - `reminderThreshold`: `z.number().default(3)`
   - `reactionWindowMs`: `z.number().default(30000)`
   两者都走与 `assertThreshold` 同款的正整数校验。

5. **`src/prompt.ts`**：新增 `REMINDER_TEXT` 常量；`repairText` 增加可选参数。

### 时序要点

注入发生在 `turn-stopping`（同步）。声明发生在工具执行时，晚于注入：

```
turn N: 未声明 → 注入（noteInjection）
turn N 后续 step: 模型看到注入 → 声明（noteDeclaration，命中窗口 → count+1）
turn N+1: 又未声明 → 注入（count 达阈值 → 带复述 → 清零）
```

跨轮累计天然成立：状态按 agent 存，不按轮次。

### 兼容性

- 工具参数与返回不变（`{ ok, state }`）。
- 注入消息结构不变，只在正文追加一段，`source.kind` 仍为 `target-monitor`。
- 无新增依赖。

## Complexity Tracking

> 无违规。
