# 插件设计：目标未达成时的续行与修复

> 状态：[UNCERTAIN] 设计草案，未实现。事实基于 DeepSeek-Harness `0.2.1-rc.5`（2026-11-05 核实）。
> 本文记录"为什么这样设计"，实现与本文不一致时以代码为准并回写本文。

## 1. 问题定义

用户的原始诉求可拆成四类故障，它们**发生在不同位置、需要不同检测点**：

| # | 故障 | 现象 | 发生位置 |
|---|---|---|---|
| F1 | 思考泄露 | 推理过程混进正文，或正文在前言处截断 | 流式生成过程中 |
| F2 | 格式异常 | 工具调用 JSON 截断/畸形，步骤无法推进 | 工具调用解析/执行 |
| F3 | 上游中断 | 连接断开、限流、流式传输半途而废 | 单次模型请求 |
| F4 | 任务中断 | 模型正常"收尾"了，但任务其实没做完 | 轮次收尾边界 |

**关键判断：不要用一个"目标监测器"同时解决四件事。** F3 已有宿主机制（见 §2）；F1/F2 需要在生成/工具层检测；只有 F4 属于"收尾前拦截"。把它们混成一个 FSM，会导致检测点错位——例如在轮次收尾处才发现思考泄露，此时脏内容已经写进历史，只能追加修复而不能阻止。

## 2. 宿主现状：已有什么

核实来源：`@deepseek-ai/dsh-*` 的 `lib/types/*.d.ts` 与 README（见 AGENTS.md §宿主事实速查）。

| 能力 | 宿主实现 | 对本插件的含义 |
|---|---|---|
| 请求级重试 | `agent/request-error`（waterfall），监听器返回 `{ kind: 'retry' }` 可接管 | **F3 不要重复实现**。默认 adapter 已有 retryPolicy；插件只在"重试耗尽但任务未完成"时补一次带证据的续行 |
| 轮次收尾拦截 | `agent/turn-stopping`（serial，awaited）；监听器可 `agent.steer()` 反对关闭，机器重读 inbox 再跑一步 | **F4 的唯一正确接点**。比"轮次结束后再注入"更早、无竞态、不产生额外轮次 |
| 持久目标状态 | `dsh-goal`：`phase: active\|paused\|blocked\|complete`，`maxGoalRounds`，revision CAS | 已有"目标"概念，但**创建门槛高**（需人类直接请求）、面向多轮自主推进 |
| 自动续行 | `dsh-goal-round-driver`：idle 时对 active+armed 的 goal 用 `agent.followup()` 排入 `<goal_round>` | 已有续行器；**遇 max tokens / 持久化失败 / 取消 / 额度耗尽即停**，异常不自动重试 |
| 系统提示词章节 | `ctx.systemPrompt.section({ name, order, text })` | 规范文本应放这里（稳定前缀，利于 KV cache），而不是每轮注入用户消息 |

### 缺口

1. 没有任何组件在 `agent/turn-stopping` 处判断"任务是否真的完成"——`dsh-workspace-changes` 只是在那里记录改动，不拦截
2. 模型"以为自己收尾了"与"任务确实完成"之间没有可编程信号
3. `dsh-goal-round-driver` 明确不处理异常终止（max tokens、provider 失败）

## 3. 方案对比

### 方案 A：用户原案——会话开始注入规范 + 异常停止时注入 "continue or done&report"

- 监测器 `working|done`，模型在汇报完成前置 done；异常停止时若为 working 则注入
- 优点：概念直白，模型侧负担小
- 缺点：
  - "异常停止"在宿主里没有统一事件，需要拼接多个信号，判断容易漏
  - 会话开始注入用户消息会污染历史、且每轮重复注入会破坏前缀缓存
  - **二态不够**：模型停下来问"用哪个文件？"也是 working → 会被无差别催促

### 方案 B：`turn-stopping` 拦截 + 工具闩锁 + 系统提示词章节（推荐）

- 规范常驻系统提示词章节（静态，只注册一次）
- 模型通过工具声明本轮状态，三态：`done` / `awaiting_user` / 未声明（默认 working）
- 收尾时读闩锁：`done` 或 `awaiting_user` → 放行；working → 带证据续行
- 优点：无竞态、不产生额外轮次、二态缺陷被修正、规范文本零重复注入
- 代价：需要新增一个模型可见工具；需要与 `dsh-goal-round-driver` 仲裁

### 方案 C：完全复用 `dsh-goal`（把 monitor 映射为 goal phase）

- 优点：零新状态
- 缺点：`create_goal` 需人类直接请求且面向多轮自主推进；每个普通对话都建 goal 语义过重；`complete` 与"本轮做完了"不是一回事
- 结论：不采用，但保留桥接——若已有 active goal，`done` 可由 `update_goal complete` 触发，工具只是别名

**决策：采用 B，C 作为桥接。** 理由：B 把判断放在宿主已经设计好的拦截点上，且不引入第二套跨轮次状态机（宪法 VII）。

## 4. 推荐设计（B 的细化）

### 4.1 状态与生命周期

```
每个用户轮次开始 → working（隐式）
模型调用 target_status('done')          → done          → 收尾放行
模型调用 target_status('awaiting_user') → awaiting_user → 收尾放行
模型未声明就走完                         → working       → 拦截并续行（受预算约束）
```

- 状态**按轮次**存在插件内存，不落盘、不进历史 → 下一轮自动回到 working，无需"自动切回"逻辑（用户原案里的"下一轮自动切 working"在这里是构造性成立，不是一段代码）
- resume / fork / 插件重载 → 状态清空，回到 working。这是安全方向：宁可多问一次，不可漏判
- 与 goal 桥接：若存在 active goal 且本轮调用了 `update_goal complete`，视同 `done`

### 4.2 三态而非二态（重要修正）

模型合法停下的情形有三类，二态监测器会把第二类误判为中断：

1. 任务完成并汇报 → `done`
2. 需要用户决策/补充信息（提问、给选项）→ `awaiting_user`
3. 意外停止（截断、限额、上游断流、模型自己走神）→ 未声明

### 4.3 收尾门（`agent/turn-stopping`）

```
on turn-stopping(agent, turn):
  if latch(turn) in {done, awaiting_user}: return            # 放行，零成本
  if repairs(turn) >= MAX_REPAIRS_PER_TURN: return           # 预算耗尽，放行并记录
  if stopCause(turn) == 'cancelled': return                  # 用户取消，绝不复活
  if !isRecoverable(stopCause): return                       # 不可恢复（如鉴权失败），放行
  agent.steer(repairPrompt(class(turn), repairs(turn)))      # 反对收尾，再来一步
  repairs(turn) += 1
```

- `MAX_REPAIRS_PER_TURN` 默认 2：第一次催续行，第二次要求"要么完成要么说明卡点"，之后放行
- 放行时写一条可审计记录（修复次数、放弃原因），便于事后归因

### 4.4 失败分类与各自的注入语料

分类主依据是宿主的 `FinishReason`（`@deepseek-ai/dsh-llm`）：

```ts
type FinishReason =
  | { kind: 'stop' }                      // 正常收尾
  | { kind: 'tool-calls' }                // 模型要调工具，不构成收尾
  | { kind: 'max-tokens' }                // 被长度上限截断
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error';   failure: LlmFailure }
```

它作为 `StreamChunk` 的 `finish` 变体，经 `agent/assistant-stream` 的 `chunk` 帧（`frame.chunk.type === 'finish'`）可被插件观察到——不需要解析文本，也不需要猜。

| 类别 | 判定 | 注入内容要点 |
|---|---|---|
| `no_progress` | `kind === 'stop'` 且本轮未声明状态 | "你停在了目标达成之前。继续工作；若已完成，调用 target_status(done) 并汇报。" |
| `truncated` | `kind === 'max-tokens'` | 指明截断："你的上一条输出被长度上限截断，从中断处继续，不要重头再来。" |
| `tool_malformed` | 工具调用解析失败（工具层错误） | 附上失败调用的名称与错误："上一条工具调用无法解析（<错误>），请重新生成该调用。" |
| `after_error` | `kind === 'aborted' \| 'error'`，或收到 `agent/error` | 附上 `failure` 类别，要求从最后已验证状态恢复，而不是重启 |

注：`max-tokens` 时宿主的 `BlockAssembler` 会丢弃无法安全执行的工具调用（`assembler.d.ts:45`），因此"截断 + 工具调用丢失"要一起说明，否则模型会以为调用已成功。

共同约束：必须携带本次证据；禁止只发"请继续"（宪法 III）。

### 4.5 与 `dsh-goal-round-driver` 的仲裁

两者都想让 agent 继续跑。冲突形态：goal 驱动的自主轮次里，turn-stopping 又催一次 → 同一轮被催两次。

仲裁规则（首选简单方案）：
- 若当前轮次来源是 goal（`<goal_round>` 消息），**本插件在该轮次不拦截**——续行由 driver 负责，本插件只管"异常终止补一次"
- 若 goal active 且 armed 且本轮是普通人类轮次，仍由本插件拦截（driver 不会在 turn 内介入）

## 5. 风险与反模式

| 风险 | 后果 | 缓解 |
|---|---|---|
| 催促循环 | 无限续行，烧 token | 每轮预算 + 放行并记录；预算耗尽不再拦 |
| 误判合法停止 | 模型问问题时被催 | `awaiting_user` 态 |
| 与 goal driver 双注入 | 自我对话循环 | §4.5 仲裁 |
| 提升提示词注入面 | 插件成为攻击面（若注入内容含外部文本） | 注入模板只用常量 + 已验证的类别/错误码，绝不拼接文件内容或工具输出原文 |
| 破坏前缀缓存 | 成本上升 | 规范只进系统提示词章节一次；注入只走 steer（追加，不改前缀） |
| 宿主升级失效 | 静默不拦截 | 兼容测试覆盖事件契约；启动时校验所需事件/服务存在，缺失则 fail loud 并自禁用 |

## 6. 未决问题

1. `target_status` 工具是否需要权限门槛（subagent 是否可调用）？倾向：仅顶层 agent，subagent 由父级统一判定
2. `awaiting_user` 能否自动推断（如最后一条消息含问句）？倾向：不推断，避免误判；但可作为降级兜底
3. F1（思考泄露）与 F2（格式异常）是否属于本插件？倾向：属于同一产品的后续切片，但**不同接点**（`agent/assistant-stream` / 工具执行层），不与 F4 共用状态机
4. 预算耗尽后是否要在会话里留一条可见提示？倾向：留在插件日志，不额外增加模型可见消息

## 7. 最小实现切片

- **M1（F4 主链路）**：系统提示词章节 + `target_status` 工具 + `turn-stopping` 门 + 每轮预算 + 单测（放行/拦截/预算/取消）
- **M2（异常补一次）**：`agent/error` 记录 + 分类 + `after_error` 语料 + 与 request-error 重试的边界测试
- **M3（仲裁与可观测）**：goal 轮次豁免、审计记录、宿主事件缺失时的 fail-loud
- **M4（另开切片）**：F1/F2 的流式与工具层检测
