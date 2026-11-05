# Contract: `target_status` 工具

**Feature**: `001-target-monitor` | **Type**: 模型可见工具（`ctx.tools.register(defineTool(...))`）

## 目的

让模型在收尾前显式声明本轮目标状态。这是插件判定"任务是否完成"的**唯一**依据（FR-014）。

## 名称与描述

- `name`: `target_status`
- `description`: `Declare this turn's target state before you close it. Use "done" only when the task is complete and you are about to report it. Use "awaiting_user" when you need a user decision or more information. Closing without declaring makes the harness assume the task is unfinished and ask you to continue.`

## 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `state` | `"done" \| "awaiting_user"` | 是 | 目标状态。不接受 `working`——不声明即视为 `working` |
| `summary` | string | 否 | 一行说明，仅用于审计与展示，不参与判定 |

## 输出

```json
{ "ok": true, "turn": 3, "state": "done" }
```

固定字段；`turn` 为当前轮次号，便于模型与日志对齐。

## 错误

| code | 触发条件 | 模型可见文案 |
|---|---|---|
| `TARGET_STATUS_NOT_ROOT` | 由非顶层 agent 调用 | `target_status is only meaningful on the top-level agent.` |
| `TARGET_STATUS_INVALID_STATE` | `state` 不在枚举内 | `state must be "done" or "awaiting_user".` |

## 语义约定

1. 调用即生效，作用于**当前轮次**；同一轮内重复调用以最后一次为准。
2. `done` 与 `awaiting_user` 均使收尾门**放行**。
3. 调用不会关闭轮次、不会缩短轮次；模型仍需自行汇报。
4. 工具不得被插件自身调用（不变量 4：状态只能由模型改变）。

## 权限

仅顶层 agent（`ctx.agents.roots()` 包含的 agent）可调用。理由：门只对顶层生效（FR-012），子 agent 的声明无处读取，允许调用只会制造误解。
