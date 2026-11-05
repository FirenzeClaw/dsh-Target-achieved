# 契约：复述文案与插入位置

**Feature**: 005-declaration-reminder

## 文案（固定常量）

```text
Reminder — the turn-closing rule:
1. When the task is complete, call target_status("done") FIRST, then report the result.
2. When you need a user decision, call target_status("awaiting_user") FIRST, then ask.
Close without declaring and the harness will treat the turn as unfinished and ask you to continue.
```

## 插入位置

追加在既有 `repairText(...)` 之后、`(attempt N in this turn)` 之前，用空行分隔：

```text
[target-monitor] Automated self-recovery notice — NOT a user message.
...
- Otherwise: continue from where you stopped. Do not restart from scratch.

Reminder — the turn-closing rule:
1. ...
2. ...
Close without declaring and the harness will treat the turn as unfinished and ask you to continue.

(attempt 4 in this turn)
```

## 约束

| 编号 | 约束 |
|---|---|
| T-001 | 文案是纯常量，不拼接轮次、计数、阈值或任何运行时数据 |
| T-002 | 只作为注入正文的尾段出现，不单独成消息，不改变 `source.kind` |
| T-003 | 出现频率由计数控制：每触发一次阈值，最多出现一次 |
| T-004 | 出现时既有文案不得删减，只做追加 |
| T-005 | 整条注入（含复述）保持在 1.5 KB 以内 |

## 与规范章节的关系

系统提示词里的 `DECLARATION_SECTION` 是"首次教学"，本契约的复述是"周期重申"。两者文案措辞不同但语义一致，且都必须写明"先声明，再汇报/等待"的顺序（spec 005 / FR-006 已在此之前落地）。
