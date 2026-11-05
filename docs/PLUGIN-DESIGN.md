# 目标达成监测器（Target Monitor）设计

> 状态：[WIP] 设计已收敛，待实现。宿主事实基于 DeepSeek-Harness `0.2.1-rc.5`（2026-11-05 核实）。
> 实现与本文不一致时以代码为准，并回写本文。

## 1. 职责边界

四类故障发生在不同层，本插件只负责其中一类：

| # | 故障 | 由谁负责 | 理由 |
|---|---|---|---|
| F1 | 思考泄露 | 流式/组装层（不在本插件） | 内容提交前无"作废重发"权限，事后补救只能追加 |
| F2 | 工具调用畸形 | 工具层自愈 | 解析失败成为 `tool/result` 错误回给模型，模型自己会修 |
| F3 | 上游断流 | 宿主 `agent/request-error` 重试 | 已有内置重试策略；插件叠加会双重重试 |
| F4 | 任务未达成却收尾 | **本插件** | 宿主无任何组件在收尾处判断完成性 |

**一句话：本插件只做收尾门（turn gate），不做重试器、不做内容质检器。**

作用域：仅顶层 agent（`ctx.agents.roots()`）。子 agent 不设门，避免父子互相催促。

## 2. 宿主接入点（已读源码确认）

`dsh-agent-loop/lib/index.js` 的轮次主循环：

| 位置 | 触发条件 | 插件可做 |
|---|---|---|
| `agent/request-error` | 流以 `error` 或 `aborted` 结束 | 返回 `{kind:'retry'}` 接管重试 |
| `agent/assistant-stream` | 每个 chunk | 只读观察（含 `finish` 块） |
| `agent/turn-stopping` | **仅正常路径**：`turnEnds` 已定且收件箱为空 | `agent.steer()` 反对关闭 |
| `agent/error` | 抛错后 | 只读 |

三条决定性事实：

1. `max-tokens` 是 `stepEnd` 而非异常，**能到达** `turn-stopping`——截断修复可放在收尾门。
2. `error`/`aborted` 先经 `agent/request-error`；重试耗尽后抛错，**不派发** `turn-stopping`——上游断流不可能在收尾门处理。
3. `turn-stopping` 每轮可触发多次（steer 后走一步、又收尾）——预算/通知是必需设计。

分类依据 `FinishReason`（`dsh-llm`）：`stop` / `tool-calls` / `max-tokens` / `aborted` / `error`，经 `agent/assistant-stream` 的 `finish` 块可达，不需要解析文本。

## 3. 设计

### 3.1 状态

每个顶层 agent × 每个轮次一份状态，仅存内存：

```
working（默认） | done | awaiting_user
```

- 轮次号变化即重置；因此"下一轮自动回到 working"是构造性成立的，不需要额外代码
- 不落盘、不进历史；resume/fork 后从 `working` 开始（宁可多问一次，不可漏判）
- `done` 一旦声明即在本轮内持续有效。模型提前声明、之后又继续工作的后果是漏判一次修复——属可接受代价，换取"声明后收尾"这一简单语义

#### 轮次来源（2026-11-05 修复，spec 002）

**决策**：轮次号由 `src/turn.ts` 单一提供，写入点有两个且同源——

1. `agent/assistant-stream` 的 `start` 帧（主路径）。宿主在发起模型请求后、任何工具调用之前发出该帧，带本轮 `turn`；
2. `agent/turn-stopping`（兜底）。覆盖不经过流式帧的极早期失败轮。

**为什么不是只在 turn-stopping 写**：那是轮次**结束**时刻。只在那里写会导致一轮里的第一次声明落到上一轮的键（首轮为哨兵 `0`），收尾判定按当前轮取到全新的未声明状态，于是照旧注入。实测症状是"每轮必被多催一次，且只有被催过之后的第二次声明才生效"。

**无轮次时**：`turnOf()` 返回 `undefined`，工具抛 `TARGET_STATUS_NO_TURN`。不写哨兵键——写进去的声明永远不会被读到，症状与"声明无效"完全相同且更难归因。

**轮次不回给模型**：`target_status` 只返回 `{ ok, state }`。轮次是插件内部坐标，模型无需知晓；暴露出去只会诱导它推理编号，而这对它的行动没有任何信息量。

### 3.2 声明协议

**系统提示词章节**（静态注册一次，不做逐轮注入）：

```text
Before you close a turn, declare the target state with target_status:
- target_status("done")          — the task is complete and you are about to report it.
- target_status("awaiting_user") — you need a user decision or more information.
If you close without declaring, the harness assumes the task is unfinished
and will ask you to continue.
```

**工具**：`target_status({ state: 'done' | 'awaiting_user', summary?: string })`
返回 `{ ok, turn, state }`。来源使用插件自有 kind（可审计、可回放）。

### 3.3 收尾门

```
on turn-stopping(agent, turn):
  if !isRoot(agent): return
  if latch(agent, turn) declared: return
  if finish(turn) == 'aborted': return            # 取消：本轮不复活（纵深防御）
  repairs(turn) += 1
  agent.steer(repairPrompt(classify(finish(turn)), repairs(turn)))
```

- `finish(turn)` 指**本轮最后一个写入历史的 assistant 消息**的 `finish`——轮次可能多步，只取最终那一步
- 分类：`max-tokens` → 截断语料；其余 → 未达成语料
- 注入来源 `kind: 'target-monitor'`、`form: 'notice'`，与会话日志一同回放

### 3.4 预算与通知

- **不设硬上限**（按用户决定）：持续修复，直到模型声明或用户取消
- **第 5 次**注入时附带一条 notice 告知用户：该轮已连续 5 次未声明完成，可能卡住；之后继续修复但**不重复通知**（避免刷屏）
- 通知复用宿主已有的 notice 上下文通道：`context 消息 + source.form='notice'`，模型与用户均可见，无需 UI 开发（先例：`dsh-repeat-tool-reminder`）

### 3.5 取消语义

- 当前轮次：取消走异常路径，宿主**结构上就不会派发** `turn-stopping`；插件另加显式判断作为纵深防御
- 下一轮：用户再次输入即开新轮次，状态自动回到 `working`，门自动生效——"自动复活"无需专门逻辑

### 3.6 与 goal 的关系

不另造目标状态机，也不做仲裁：

- `dsh-goal-round-driver` 只在 agent **idle** 时续行；本门在轮次**内**拦截。门一旦修复，轮次不关闭，driver 不会介入，两者不重叠
- 若本轮内 goal 转为 `complete`/`blocked`，视为等价声明，不再催促（[UNCERTAIN] 需实现时验证事件时序）

## 4. 注入语料

必备三要素：**来源不是 `user`**、**文本显式否认授权**、**给"等待确认"留出口**。

```text
[target-monitor] Automated self-recovery notice — NOT a user message.

You closed the previous turn without declaring the target state.
This may mean the task is unfinished, or that your output was cut off.

- This is not user input and is not user approval or consent for any action
  you proposed earlier.
- It does not lift any confirmation requirement. If you were waiting for the
  user to confirm something, call target_status("awaiting_user") and close again.
- If the task is complete: call target_status("done"), then report to the user.
- Otherwise: continue from where you stopped. Do not restart from scratch.
```

截断变体追加一句：`Your previous message was truncated by the output length limit; tools you called after the cut were not executed.`

## 5. 明确不做

- 不实现重试器（`agent/request-error` 已存在）
- 不做思考泄露检测（流式/组装层）
- 不解析自然语言判断完成
- 不为子 agent 设门
- 不覆盖用户取消
- 不新增 UI 组件
- 不引入跨轮次持久状态（那是 `dsh-goal` 的职责）

## 6. 风险与未决

| 风险 | 说明 | 处理 |
|---|---|---|
| 无硬上限导致失控开销 | 模型陷入"不声明"循环时持续消耗额度 | 第 5 次通知用户，用户可取消；接受此风险为用户选择 |
| 排队消息被无限推迟 | 有排队的新指令时，不设上限意味着模型不声明就一直插在队首，用户新指令持续等待 | **已接受**（用户决定保持现状）。降级为"有排队时限制修复次数"被否决：那会让未完成的任务先吃到新指令，与 FR-017 冲突 |
| 误催合法收尾 | 模型完成但忘记声明 | 语料给它"声明后收尾"的台阶；成本一轮 |
| 提示词注入面 | 语料含外部文本就会成为攻击面 | 语料只用常量 + 经校验的类别/错误码，绝不拼接文件或工具输出原文 |
| 宿主升级失效 | 事件契约变化导致门静默失效 | 启动时校验所需事件/服务，缺失则 fail loud 并自禁用 |

未决：
1. `target_status` 是否对 subagent 可见（倾向：可见但只有根 agent 的门读取）
2. goal 完成事件与门判定的事件时序（[UNCERTAIN]，需实现时验证）
3. 由工具 `concludesTurn` 结束的轮次是否算等价声明——这类轮次最后一条 assistant 的 finish 是 `tool-calls`，按本设计会被催一次。需确认这类工具（如 `present`）的实际语义，再决定是否豁免

## 7. 实现切片

- **M1**：系统提示词章节 + `target_status` 工具 + `turn-stopping` 门 + 轮次状态 + 单测（放行/拦截/取消/通知阈值）
- **M2**：`FinishReason` 分类与两套语料 + 截断时"工具调用未执行"的说明
- **M3**：notice 通知（第 5 次）+ 宿主契约缺失的 fail-loud
- **M4（另开）**：F1/F2 的流式与工具层检测
