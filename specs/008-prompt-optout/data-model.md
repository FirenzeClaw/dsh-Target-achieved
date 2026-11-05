# Data Model: 初始注入开关与设置界面接管

## ClientConfigView

分区从宿主读到的一份配置快照。

| 字段 | 类型 | 说明 |
|---|---|---|
| `ns` | string | 命名空间键；来自 profile 条目，用户可改名，故不用于识别 |
| `value` | unknown | 已解析的配置（schema 默认 → 组合基线 → 用户层） |
| `revision` | number | 写回时必须带回；不匹配则宿主拒绝 |
| `writable` | boolean | 来自 `describe()` 顶层；`false` 时整个分区禁用 |

**识别规则**：`value` 为对象且含 `stallNoticeThreshold` 键。

## FieldSpec

分区渲染一个字段所需的全部信息。

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 配置键名 |
| `kind` | `'boolean' \| 'number'` | 控件类型 |
| `label` | string | 显示名 |
| `hint` | string | 一句说明（FR-009） |

**八个字段**（FR-008 列七个，实现时已含 007 新增的 `crossProcess`）：

| key | kind | 默认 |
|---|---|---|
| `declarationSection` | boolean | true |
| `enabled` | boolean | true |
| `stallNoticeThreshold` | number | 5 |
| `reminderThreshold` | number | 3 |
| `reactionWindowMs` | number | 30000 |
| `crossProcess` | boolean | true |
| `resumeOnUpstreamError` | boolean | true |
| `maxResumes` | number | 3 |

## CopyTarget

| 字段 | 类型 | 来源 |
|---|---|---|
| `declarationText` | string | 构建期从 `dist/prompt.js` 的 `DECLARATION_SECTION` 注入 |
| `agentsSnippet` | string | 构建期拼为 `## Target status declaration\n\n` + 上述正文 |

两者都是常量，不含运行时数据（宪法原则 III）。

## 状态转移

分区只有三种可观察状态：

```
loading ──describe 成功──▶ ready ──update 成功──▶ ready（revision 更新）
   │                        │
   └──describe 失败──▶ error └──update 失败──▶ error（可重试）
```

冲突（`SETTINGS_CONFLICT`）归入 `error`，提示刷新，不静默覆盖（FR-011）。
