# Quickstart: 轮次键对齐

**Feature**: 002-turn-key-alignment

## 前置

```bash
cd /home/firenzeclaw/Code/DSH-Target-achieved
npm run build          # tsc → dist/
npm test               # node --test
```

## 自动化验证

### 1. 回归测试（核心）

```bash
npm test
```

预期：`tests/integration/turn-key.test.ts` 通过，且以下断言成立——

- 模拟 `start` 帧（turn = 7）→ 调用声明 → 工具报 `turn: 7`；
- 随后触发收尾判定 → **不注入**；
- 未声明时触发收尾判定 → **注入**（attempt 1）；
- 轮次变为 8 后不再继承 turn 7 的声明。

**反向验证（证明测试有效）**：把 `src/index.ts` 里 `start` 帧的 `currentTurn.set` 注释掉，重新 `npm test`，该测试必须失败。验证后恢复。

### 2. 既有测试不回退

```bash
npm test 2>&1 | tail -5
```

预期：`fail 0`，总数 = 原 47 + 新增（2026-11-05 现为 198 项）。

### 3. 类型与构建

```bash
npm run typecheck && npm run build
```

## 真实会话验证

重启 `dsh web` 后（`dist/` 变更不会被 HMR 拾取），在新一轮里：

| 步骤 | 操作 | 预期 |
|---|---|---|
| A | 本轮开头就调用 `target_status("done")` | 返回 `turn` 等于**当前轮次**（不再是上一轮或 0） |
| B | 纯文本收尾 | **无** `[target-monitor]` 注入，轮次直接关闭 |
| C | 新一轮开头调用 `target_status("awaiting_user")` | 返回当前轮次 |
| D | 纯文本收尾 | **无**注入，等待用户 |
| E | 连续 3 轮主动声明 | 注入总数 0（缺陷前为每轮 1 次） |

## 已知不在本次范围

- ~~插件加载后的第一次收尾可能仍未触发监听器~~：2026-11-05 经会话日志核实不成立（11:53 加载后的首轮正常注入；未注入的那轮早于加载 7 分钟），结论已撤销，勿据此排查。
- 阈值提示（第 5 次未声明）：2026-11-05 已用守护进程真实 IPC 验证（同一会话连续 5 次 `turn-stopping`，第 5 次返回 `stallNotice: true`）；真实聊天轮次内仍未复现到第 5 次，用户可见路径建议在真实会话中复核。
