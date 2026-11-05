# Quickstart: 声明规范复述

**Feature**: 005-declaration-reminder

## 前置

```bash
cd /home/firenzeclaw/Code/DSH-Target-achieved
npm run build && npm test
```

## 自动化验证

### 1. 计数与触发（核心）

```bash
npm test 2>&1 | grep -E "遗忘|复述"
```

预期用例：

- 连续三次"注入 → 窗口内声明"后，第四次注入正文包含 `Reminder — the turn-closing rule`。
- 前三次注入**不含**该段。
- 一次"注入后未声明、继续干活"不改变计数（构造为：注入 → 再次注入 → 声明，此时不应计数）。
- 复述发出后，第五次注入不含复述（计数已清零）。

### 2. 配置生效

```bash
npm test 2>&1 | grep -E "阈值|窗口"
```

预期：

- `reminderThreshold = 1` 时，第一次遗忘后的下一次注入就带复述。
- `reactionWindowMs = 1` 时，正常速度的声明不再被计为遗忘。

### 3. 反向验证

把 `src/gate.ts` 里调用 `takeReminderDue` 的那行注释掉，`npm test` 必须失败。验证后恢复。

### 4. 回归

```bash
npm test 2>&1 | tail -3
npm run typecheck && npm run build
```

预期 `fail 0`，总数 = 55 + 新增。

## 真实会话验证（需重启 `dsh web`）

1. 连续 4 轮在收尾时**故意不声明**，每轮都在收到注入后才声明。
2. 观察第 4 次注入的正文：应包含 `Reminder — the turn-closing rule`。
3. 之后再重复，第 5–7 次不含复述，第 8 次（新周期第 4 次）再次出现。

## 已知不在本次范围

- 计数不跨进程重启保留。
- 阈值/窗口的设置页入口依赖 004 落地。
