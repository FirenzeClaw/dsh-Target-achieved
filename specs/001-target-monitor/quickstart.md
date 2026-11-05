# Quickstart: 验证收尾门

**Feature**: `001-target-monitor` | **Date**: 2026-11-05

本文件只描述"怎么跑起来并确认它真的生效"，不包含实现代码。命令在 M1 落地 `package.json` 之后成立；在此之前仅有 `node --test` 与 `tsc` 两条依赖，无需额外脚手架。

## 前置

- Node.js ≥ 22（本机 24.22.1）
- 宿主已安装：`/home/firenzeclaw/.nvm/versions/node/v24.22.1/lib/node_modules/@deepseek-ai/dsh`
- 插件依赖宿主提供的 peer 包，开发期用脚本链接（`scripts/link-host.sh`，`DSH_INSTALL_DIR` 可覆盖路径）

## 构建与测试

```bash
# 链接宿主的 @deepseek-ai 包到本地 node_modules（仅类型与本地运行需要）
bash scripts/link-host.sh

# 单元测试：Node 内置 runner，直接执行 TypeScript
node --test 'tests/**/*.test.ts'

# 类型检查 / 构建
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.json
```

预期：`node --test` 全部通过；`--noEmit` 无错误。两项都必须真跑过才能声称"可用"。

## 挂载到 profile

在 `~/.dsh/profiles/web/cordis.patch.yml` 追加（路径按实际包位置调整）：

```yaml
- insert:
    - id: target-monitor
      name: 'dsh-target-monitor'
      config:
        enabled: true
        stallNoticeThreshold: 5
```

重启宿主（或依赖 HMR），确认启动日志中无 fail-loud 错误。

## 端到端验证场景

以下场景对应 spec.md 的用户故事，每条都给出"怎么观察"，需在真实会话中逐条走查。

### S1 — 未声明即收尾会被续行（US1，P1）

1. 给模型一个需要两步的任务（例如"读 A 文件，然后按它改 B 文件"）。
2. 在其只做了第一步时人为中断输出（或构造一个不声明就收尾的响应）。
3. 预期：**同一轮内**出现一条 `[target-monitor]` 提醒，随后模型继续；用户无需再次输入。

### S2 — 声明等待用户则不被打扰（US2，P1）

1. 触发一次需要确认的操作（删除、覆盖）。
2. 模型调用 `target_status("awaiting_user")` 后提问。
3. 预期：**无**任何 `[target-monitor]` 消息；对话正常停在该提问。

### S3 — 截断续行且说明工具未执行（US3，P2）

1. 让模型输出触及长度上限（例如生成长文件）。
2. 预期：提醒中出现"被长度上限截断、截断后的工具调用未执行"的说明；非截断场景不出现该段。

### S4 — 卡住时告知用户（US4，P2）

1. 构造同一轮内连续 5 次不声明的响应。
2. 预期：第 5 次出现面向用户的"可能卡住"提示；第 6 次及以后不再重复出现该提示。

### S5 — 取消优先，下一轮恢复（US5，P3）

1. 在模型工作过程中点击中断。
2. 预期：无任何提醒（本轮不复活）。
3. 再次输入任意内容。
4. 预期：新一轮照常受门控（未声明收尾会被提醒）。

### S6 — 子助手不设门（Edge Case）

1. 触发一次子 agent 执行。
2. 预期：子 agent 收尾时不产生任何 `[target-monitor]` 消息。

## 回归与冒烟

```bash
# 每次改动后的最小验证
node --test 'tests/**/*.test.ts'
npx tsc -p tsconfig.json --noEmit
```

若修改了文案或来源字段，额外核对：提醒消息的 `source.kind` 必须为 `target-monitor`，`source.form` 必须为 `notice`（见 [contracts/notice.message.md](./contracts/notice.message.md)）。

## 已知需要人工确认的点

| 项 | 为什么需要人工 | 判据 |
|---|---|---|
| `steer` 在 `turn-stopping` 内确实能再走一步 | 依赖宿主内部时序 | S1 场景可复现 |
| `concludesTurn` 轮次的语义 | 是否等价于"主动完成" | 观察 `present` 等工具的收尾是否被误催 |
| 第 5 次提示的用户可见性 | 依赖 Web 端对 `form:'notice'` 的渲染 | S4 场景在界面可见 |
