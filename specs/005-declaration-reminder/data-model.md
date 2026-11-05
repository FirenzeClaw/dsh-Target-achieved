# Data Model: 声明规范复述

**Feature**: 005-declaration-reminder · **Date**: 2026-11-05

## 实体：ForgetState（每个 agent 一份）

| 字段 | 类型 | 说明 |
|---|---|---|
| `count` | `number` | 当前周期内已累计的"遗忘"次数 |
| `pendingAt` | `number \| undefined` | 最近一次注入的时间戳；`undefined` 表示没有待判定的注入 |
| `reminderDue` | `boolean` | 计数已达阈值，等待在下一次注入中发出复述 |

**存储**：`WeakMap<Agent, ForgetState>`，进程内，不持久化。agent 被 dispose 时随 WeakMap 自然回收，另提供显式 `forgetForgetful`。

**不变量**：

1. `pendingAt !== undefined` 时，`count` 尚未包含这次注入的结果。
2. `reminderDue === true` 时，`count >= threshold`。
3. `reminderDue` 为真期间不会再有新的注入被计数——复述发出后立即清零并复位。

## 状态转换

```text
事件 A：注入发出 noteInjection(now)
  若 pendingAt 已有值（上一次注入未被响应）
     → 丢弃旧值，count 不变            （真中断，不计数不清零）
  pendingAt = now

事件 B：声明成功 noteDeclaration(now, window)
  若 pendingAt 存在且 now - pendingAt <= window
     → count += 1
  无论命中与否 → pendingAt = undefined
  若 count >= threshold → reminderDue = true

事件 C：发出注入时 takeReminderDue()
  若 reminderDue
     → 返回 true，并把 count = 0、reminderDue = false
  否则返回 false
```

## 与既有状态的边界

| 既有结构 | 关系 |
|---|---|
| `TurnLatch`（`src/state.ts`） | 按轮次存，随轮次重建；**不参与**本特性计数，否则永远到不了阈值 |
| `currentTurn`（`src/turn.ts`） | 仅用于让声明落到正确轮次；与本特性无关 |
| `config.enabled` | 关闭时判定直接返回，不产生注入，因此也不推进计数 |

## 校验规则

| 规则 | 断言 |
|---|---|
| 阈值必须是正整数 | `reminderThreshold >= 1` 且为安全整数 |
| 窗口必须是正整数 | `reactionWindowMs >= 1` 且为安全整数 |
| 一次注入最多计一次 | 同一 `pendingAt` 只被 `noteDeclaration` 消费一次 |
| 复述不与注入分离 | 复述只作为注入正文的尾段存在，不单独成消息 |

## 配置

| 字段 | 默认 | 类型 | 可编辑 |
|---|---|---|---|
| `reminderThreshold` | 3 | 正整数 | 是（volatile） |
| `reactionWindowMs` | 30000 | 正整数 | 是（volatile） |
