# 契约：`target_status` 工具

**Feature**: 002-turn-key-alignment · **变更类型**: 行为修复（接口不变）

## 参数（不变）

| 名称 | 类型 | 必填 | 取值 |
|---|---|---|---|
| `state` | `string` | 是 | `"done"` \| `"awaiting_user"` |
| `summary` | `string` | 否 | 一行审计摘要 |

## 返回值（不变）

```json
{ "ok": true, "turn": 3, "state": "done" }
```

| 字段 | 语义 |
|---|---|
| `ok` | 恒为 `true`；失败以异常表达 |
| `turn` | **调用发生的那一轮**的轮次号。修复前可能返回上一轮的值或 `0` |
| `state` | 记录下来的状态 |

## 错误（新增一条）

| 错误码 | 触发条件 | 消息要点 |
|---|---|---|
| `TARGET_STATUS_DISABLED` | 配置 `enabled: false` | 已存在 |
| `TARGET_STATUS_NOT_ROOT` | 非顶层 agent 或缺少 agent | 已存在 |
| `TARGET_STATUS_INVALID_STATE` | `state` 不是两个合法值之一 | 已存在 |
| `TARGET_STATUS_NO_TURN` | **新增**：插件尚未观察到任何轮次 | 说明无法确定轮次，拒绝写入 |

## 行为契约

1. 成功调用后，`isDeclared(agent, turn) === true`，其中 `turn` 即返回值里的 `turn`。
2. 同一轮内后声明覆盖前声明，`turn` 不变。
3. 声明不跨轮继承；轮次 +1 后状态回到 `working`。
4. 声明本身不产生任何注入；只有收尾判定读取它。

## 向后兼容

- 参数与成功返回结构不变，调用方无需修改。
- 唯一可见差异：`turn` 从"可能是上一轮"变成"一定是本轮"；以及在无轮次时由"静默写 `0`"变成显式报错。
