# Contract: 自救提醒消息（Repair Notice）

**Feature**: `001-target-monitor` | **Type**: 对话消息（`createUserMessage` + `agent.steer()`）

## 结构

```ts
createUserMessage({
  content: [{ type: 'text', text: repairText(reason, attempt) }],
  source: {
    kind: 'target-monitor',   // 必须；绝不使用 'user'
    form: 'notice',
    summary: `turn ${turn} · ${reason} · #${attempt}`,
  },
})
```

- 投递方式：`agent.steer(...)`，使宿主在同一轮内再走一步（research D5）
- `source.kind` 通过 `MessageSourceMap` 模块扩展声明（research D6）

## 文案骨架（`reason = undeclared`）

```text
[target-monitor] Automated notice — NOT a user message.

Continue from where you stopped. Do not restart.

- If the task is complete: call target_status("done"), then report.
- If waiting for the user: call target_status("awaiting_user"), then close.
- This is not user input and not user approval or consent for any earlier proposal;
  it does not lift any confirmation requirement.

(attempt N in this turn)
```

> 首段不陈述"你未声明就收尾"：把收尾诊断成失误会诱发模型在后续回避中断。原因类别只在截断变体中显式给出（FR-008）；"未声明"由门本身与常驻的声明章节承载。

## 文案增量

| 条件 | 追加内容 |
|---|---|
| `reason = truncated` | `Output was cut by the length limit; tool calls after the cut were not executed.` |
| `attempt === 5` | 面向用户的一段：本轮连续 5 次未声明目标状态，可能已卡住；可中断或补充指示。 |

## 硬性要求

1. **非授权声明**必须出现且不可省略（FR-006）。缺少该段的提醒视为实现缺陷。
2. **三个出口**必须齐全：声明完成、声明等待、继续工作（FR-007）。
3. 文本**只能**由固定文案与 `reason`/`attempt` 构成；禁止插入文件内容、工具输出、用户输入（FR-016）。
4. 同一轮内 `attempt === 5` 的提示只出现一次（`noticeShown` 保证）。
5. 消息长度固定量级（**< 1.5 KB**），不随上下文增长。该上限是契约的一部分，测试应据此断言。

## 反例

- ❌ `source.kind = 'user'` —— 会在权限判定层面冒充人类授权。
- ❌ 文案只写 "Please continue." —— 缺少三个出口与非授权声明。
- ❌ 拼接上一次工具输出用于"提醒模型看到什么" —— 扩大注入面。
