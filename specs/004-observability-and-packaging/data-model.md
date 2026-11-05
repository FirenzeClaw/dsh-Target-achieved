# Data Model: 可观测性与可分发

**Feature**: 004-observability-and-packaging · **Date**: 2026-11-05

## 实体：GateTrace（一次收尾判定）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `at` | `number` | 是 | 判定时刻（epoch ms），用于排序与按时间回溯 |
| `session` | `string` | 是 | agent 标识的 8 位十六进制短哈希；不落原文 |
| `turn` | `number` | 是 | 轮次号，取自 `turnOf(agent)`；未知时为 -1 |
| `outcome` | `'injected' \| 'released'` | 是 | 是否注入 |
| `reason` | `GateReason` | 是 | 放行/注入的原因，见下表 |
| `attempt` | `number` | 是 | 本轮第几次注入（1 起）；`released` 时为 0 |

### GateReason 取值

| 值 | 含义 | 对应 outcome |
|---|---|---|
| `undeclared` | 轮次结束但从未声明 | `injected` |
| `declared` | 已声明 done / awaiting_user | `released` |
| `disabled` | 配置关闭 | `released` |
| `not-root` | 非顶层 agent，不介入 | `released` |
| `aborted` | 用户取消，不自动复活 | `released` |
| `error` | 轮次因错误结束，交由既有重试层 | `released` |

**不变量**：

1. `outcome === 'injected'` 当且仅当 `reason === 'undeclared'`。
2. `attempt >= 1` 当且仅当 `outcome === 'injected'`。
3. 每条记录都只对应一次 `turn-stopping` 判定——同一轮多次判定会产出多条，以 `at` 区分。

## 实体：TraceSink（写入端）

| 属性 | 值 |
|---|---|
| 路径 | `<home>/logs/target-monitor/gate-trace.jsonl` |
| 编码 | UTF-8，每行一个 JSON 对象，行尾 `\n` |
| 轮转 | 写入前 `statSync`，超 2 MiB 则 `rename` 为 `.1`（覆盖已有 `.1`） |
| 上限 | 2 个文件（`.jsonl` + `.jsonl.1`） |
| 失败策略 | try/catch，首次失败设进程内标记，后续静默 |

`<home>` 解析顺序：`$DSH_HOME` → `~/.dsh` → `os.tmpdir()/dsh`。

## 实体：RingBuffer（读取端，仅测试/调试）

| 属性 | 值 |
|---|---|
| 容量 | 200 条 |
| 生命周期 | 进程内，重启即失 |
| 用途 | 单测断言、调试时快速查看最近判定 |
| 对外 | `recentTraces()` 返回副本（不可变） |

## 状态转换

留痕没有状态机——每次判定独立写一条。唯一的状态是 `sinkFailed: boolean`：

```text
recordTrace(entry)
  → sinkFailed === true → 直接返回
  → 构造行 → appendFileSync
      ├─ 成功 → 更新环形缓冲
      └─ 失败 → sinkFailed = true；写一条内部告警（仅一次）
```

## 校验规则

| 规则 | 说明 |
|---|---|
| 字段集合固定 | 多写字段视为契约违规（测试断言键集合） |
| `turn` 非负或 -1 | 不写 `undefined`，避免 JSON 丢键 |
| `session` 长度 = 8 | 十六进制小写 |
| 无自由文本字段 | 防止用户内容漏进日志（安全红线） |

## 打包元数据（非运行时实体，但同样有契约）

| 字段 | 值 |
|---|---|
| `engines.dsh` | `>=0.2.1-rc.5 <0.3.0` |
| `dsh.manifestVersion` | `1` |
| `dsh.bundle.patch` | `dsh.bundle.patch` |
| `files` | `["dist", "dsh.bundle.patch", "README.md"]` |
| `private` | 移除 |
| `keywords` | `["dsh", "dsh-plugin", "target-status", "turn-gate"]` |
