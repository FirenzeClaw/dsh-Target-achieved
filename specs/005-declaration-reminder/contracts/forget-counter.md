# 契约：遗忘计数触发条件

**Feature**: 005-declaration-reminder

## 计数规则

| 编号 | 条件 | 结果 |
|---|---|---|
| C-001 | 注入发出后，在 `reactionWindowMs` 内发生一次成功的 `target_status` 调用（任意状态） | `count += 1` |
| C-002 | 注入发出后，窗口内没有成功声明，且下一次注入已发生 | `count` 不变（不清零、不减一） |
| C-003 | 声明发生在窗口之外 | `count` 不变 |
| C-004 | 一次注入只能被计数一次 | 第二次声明不重复计数（`pendingAt` 已被消费） |
| C-005 | 声明失败（被拒绝、非顶层、无轮次） | 不计入 `count` |
| C-006 | 配置 `enabled: false` | 不产生注入 → 不影响计数 |
| C-007 | `count` 达到 `reminderThreshold` | 置 `reminderDue = true`，但**不立即清零** |
| C-008 | 复述随某次注入发出 | `count = 0`、`reminderDue = false` |
| C-009 | agent 被 dispose | 计数随之清除 |
| C-010 | 进程重启 | 计数从零开始（不持久化） |

## 判据来源

- "注入发出"：`src/gate.ts` 中 `deps.deliver(...)` 被调用的时刻。
- "声明成功"：`src/tool.ts` 中 `declare(agent, turn, state)` 执行完成的时刻。
- "窗口"：`Date.now()` 差值，不使用定时器。

## 反例（必须不发生）

- 真中断（模型收到注入后继续干活、没有声明）把 `count` 打回零 → 特性在长任务里永远不触发。
- 同一次注入被两次声明各计一次 → 阈值提前触发。
- 达到阈值就清零、但恰逢该轮无注入 → 复述丢失且计数归零，永不发出。
