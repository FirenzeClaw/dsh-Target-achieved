# Quickstart：验证上游异常自动续行

## 前置

```bash
cd /home/firenzeclaw/Code/DSH-Target-achieved
npm run typecheck && npm test && npm run build
```

插件已通过 `link:` 挂载进 `~/.dsh/profiles/web`；改完 `dist/` 需重启 `dsh web` 生效。

## 1. 自动化验证（不需要真实上游）

```bash
npm test
```

预期：

- `tests/unit/resume.test.ts` 覆盖分类矩阵（5 个可重试码逐个通过、4 个不可重试码逐个拒绝、非 `LlmError` 拒绝、`aborted` 拒绝）；
- `tests/integration/upstream-resume.test.ts` 驱动真实 `apply`，断言：可重试错误后 `steer` 被调用一次、文案等于 `repairText('undeclared', 1)`、计数累加、达上限后不再调用；
- 反向验证：把 `whenIdle()` 换成同步投递，至少一条用例失败。

## 2. 留痕兼容验证

```bash
rm -f ~/.dsh/logs/target-monitor/gate-trace.jsonl
# 跑一轮会触发续行的会话后：
jq -c 'select(.reason | startswith("upstream"))' ~/.dsh/logs/target-monitor/gate-trace.jsonl
jq -c 'select(.outcome == "injected")' ~/.dsh/logs/target-monitor/gate-trace.jsonl   # 旧查询仍可用
```

预期：第一条能看到 `errorCode`；第二条仍返回既有注入记录（若有）。

## 3. 真实会话验证（需要制造一次上游失败）

任选一种：

- 把 profile 里该 provider 的 base URL 指向一个不可达地址，等宿主重试耗尽；
- 或在网络层注入一次 429（如临时改 hosts 或用本地代理返回 429）。

预期：

1. 轮次以错误结束后，**不需要用户做任何操作**，几秒内自动开启新一轮；
2. 新一轮里模型能看到 `[target-monitor] Automated notice — NOT a user message.`；
3. 恢复上游后，该轮正常收尾并按协议声明 `target_status("done")`；
4. 留痕中出现 `upstream-resumed`，`consecutive` 在该轮正常收尾后清零（可再触发一次失败验证重新从 1 开始计数）。

## 4. 不该续行的情形

| 场景 | 操作 | 预期 |
|---|---|---|
| 用户取消 | 轮次执行中点停止 | 不投递，留痕 `upstream-skipped` |
| 不可重试码 | 用错误的 API key 触发 `AUTH` | 不投递 |
| 开关关闭 | 设置页关掉 `resumeOnUpstreamError` | 不投递 |
| 上限 | 连续制造 4 次失败 | 前 3 次投递，第 4 次留痕 `upstream-capped` |
