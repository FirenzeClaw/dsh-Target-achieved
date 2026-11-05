# 契约：判定留痕记录

**Feature**: 004-observability-and-packaging

## 写入契约

`recordTrace(entry: GateTrace): void`

| 编号 | 约定 |
|---|---|
| R-001 | 每次 `turn-stopping` 判定结束时调用且仅调用一次 |
| R-002 | 同步追加一行 JSONL；返回前不等待任何 I/O 完成通知 |
| R-003 | 任何异常都在函数内部吞掉并标记 `sinkFailed`，**绝不向调用方抛出** |
| R-004 | 目录不存在时递归创建（`mkdirSync({ recursive: true })`） |
| R-005 | 记录内容不含对话文本、工具参数、用户输入、文件路径 |

## 读取契约

`recentTraces(): readonly GateTrace[]`

| 编号 | 约定 |
|---|---|
| R-006 | 返回最近 200 条的快照，新→旧排序 |
| R-007 | 返回的是副本；调用方修改不影响内部缓冲 |
| R-008 | 只反映本进程内产生的记录，不含历史文件内容 |
| R-009 | 进程重启后清空 |

## 检索方式（面向维护者）

```bash
# 某一轮的全部判定
jq -c 'select(.turn == 7)' ~/.dsh/logs/target-monitor/gate-trace.jsonl

# 最近 20 条
tail -n 20 ~/.dsh/logs/target-monitor/gate-trace.jsonl | jq -c .

# 有没有注入过
jq -c 'select(.outcome == "injected")' ~/.dsh/logs/target-monitor/gate-trace.jsonl
```

**判据**：某轮在文件里查不到任何记录，才说明该轮**未被判定**（而不是"判定后放行"）。

## 反例（必须不发生）

- 记录出现在对话消息、系统提示词或任何工具返回值中 → 违反 FR-003。
- 磁盘写满导致 `turn-stopping` 抛错、轮次收尾被打断 → 违反 FR-007。
- 文件无界增长 → 违反 FR-005。
- 两个并发 agent 的记录无法区分 → 违反 FR-006。

## 兼容性

新增字段属于契约变更，需同步更新本文件与 `data-model.md`；已有 6 个字段不得改名或改语义。
