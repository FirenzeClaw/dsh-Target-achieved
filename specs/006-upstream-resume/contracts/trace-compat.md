# Contract：留痕兼容

本契约保证：新增错误路径留痕后，**既有查询与既有记录语义不变**。

## T-001 字段不变

`at` / `session` / `turn` / `outcome` / `reason` / `attempt` 六个既有字段的类型与含义 MUST 保持不变。

## T-002 outcome 不新增取值

`outcome` MUST 仍只有 `injected` 与 `released`。续行投递记为 `injected`，跳过记为 `released`——「投递了没有」与「为什么投递/跳过」是两个正交维度，不应合并进一个字段。

## T-003 reason 只追加

新增 `upstream-resumed` / `upstream-skipped` / `upstream-capped`，MUST NOT 修改或删除既有六个值（`undeclared` / `declared` / `disabled` / `not-root` / `aborted` / `error`）。

## T-004 新字段可选

`errorCode` MUST 为可选字段；缺失时消费者按 `undefined` 处理。仅在 `agent/error` 路径写出。

## T-005 文件不变

路径仍为 `$DSH_HOME/logs/target-monitor/gate-trace.jsonl`；轮转阈值 2 MiB、保留两代、单行一条 JSON——均不变。

## T-006 查询不变

下列既有查询在改造后 MUST 返回与改造前一致的结果集（新增记录除外）：

```bash
jq -c 'select(.turn == 7)' ~/.dsh/logs/target-monitor/gate-trace.jsonl
jq -c 'select(.outcome == "injected")' ~/.dsh/logs/target-monitor/gate-trace.jsonl
jq -c 'select(.reason == "undeclared")' ~/.dsh/logs/target-monitor/gate-trace.jsonl
```

## T-007 可区分性

任一续行判断 MUST 能从留痕中还原三件事：该轮是否续行、错误码是什么、是否因达上限而停手。
