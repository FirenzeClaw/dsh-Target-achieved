# Phase 1 Data Model: 目标达成监测器

**Feature**: `001-target-monitor` | **Date**: 2026-11-05

本特性不持久化任何数据。以下实体均驻留内存，生命周期与"轮次"绑定；持久化不在范围内（见 research.md D3）。

## 实体

### 1. TargetState（目标状态）

轮次内"任务是否已达成"的唯一判定依据。

| 取值 | 含义 | 由谁设置 |
|---|---|---|
| `working` | 进行中（默认） | 轮次开始时间接确定，无需赋值 |
| `done` | 任务完成、即将汇报 | 模型调用 `target_status` |
| `awaiting_user` | 需要用户决策/补充信息 | 模型调用 `target_status` |

**约束**
- 每轮只有一个状态；同一轮内后一次声明覆盖前一次。
- `done` 一旦设置，本轮内持续有效（即使模型继续工作）——已知代价：可能漏判一次续行。
- 状态不跨轮：新轮次即 `working`。

### 2. TurnLatch（轮次闩锁）

状态在内存中的承载，按 `(agent, turn)` 定位。

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn` | number | 轮次号，来自宿主事件 |
| `state` | `TargetState` | 当前声明，缺省 `working` |
| `repairs` | number | 本轮已发出的自救提醒次数，从 0 开始 |
| `noticeShown` | boolean | 第 5 次提示是否已展示，保证每轮最多一次 |

**键策略**：每个顶层 agent 只保留"当前轮"一条；轮次号变化即整体替换，不做历史保留。
**销毁条件**：agent 失效、轮次结束、插件卸载。

### 3. RepairNotice（自救提醒）

投递给模型（同时用户可见）的一条对话消息。

| 字段 | 说明 |
|---|---|
| `reason` | `undeclared`（未声明即收尾）/ `truncated`（长度上限截断） |
| `attempt` | 本轮第几次提醒（正整数） |
| `text` | 固定文案 + 原因段落，**不含**任何外部文本 |
| `source.kind` | `target-monitor`（非 `user`） |
| `source.form` | `notice` |
| `source.summary` | 一行摘要，如 `turn 3 · undeclared · #2` |

**校验规则**
- 文案必须含三条：非用户消息/不构成授权、不解除确认要求、三个出口（完成并汇报、等待用户、继续）。
- `attempt === 5` 时附加"可能卡住"的面向用户提示，且 `noticeShown` 置位。
- 任何情况下不得拼接文件内容、工具输出或用户输入原文（FR-016）。

### 4. StopCause（结束原因）

从 `FinishReason` 归一化后的分类，只用于选择文案。

| 输入 | 归一化 |
|---|---|
| `max-tokens` | `truncated` |
| `stop` | `undeclared` |
| `tool-calls` | `undeclared`（`concludesTurn` 情形待实测，见 research 未决项） |
| `aborted` / `error` | 不产生提醒（本钩子不可达；防御性返回） |

## 状态转移

```
[轮次开始]
   │
   ▼
 working ──target_status('done')──────────► done ────────────► 放行
   │                                        ▲
   │ target_status('awaiting_user')         │（同一轮内可覆盖）
   ▼                                        │
 awaiting_user ─────────────────────────────┘
   │
   │ 轮次即将关闭且未声明
   ▼
 发出 RepairNotice（repairs += 1）
   │
   ├─ repairs == 5 且 !noticeShown ──► 附"可能卡住"提示，noticeShown = true
   └─ 继续等待模型声明
```

**取消**：`aborted` 或用户取消 → 不产生提醒，本轮结束；下一轮重新从 `working` 开始。

## 不变量

1. 任一时刻，每个顶层 agent 至多一条 `TurnLatch`。
2. `repairs` 单调递增，且仅在"未声明即收尾"时增加。
3. `noticeShown` 在一轮内至多由 false 变 true 一次。
4. `TargetState` 只能由模型工具调用改变，插件自身不得代设。
5. 任何 `RepairNotice` 的 `source.kind` 不得为 `user`。
