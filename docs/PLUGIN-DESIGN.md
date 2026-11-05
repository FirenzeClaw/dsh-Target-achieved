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
Before closing a turn, declare its target state with target_status. Declare first, then report:
1. Complete → call target_status("done") first, then report the result.
2. User decision needed → call target_status("awaiting_user") first, then ask.
An undeclared close is treated as unfinished; the harness continues the turn.
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
[target-monitor] Automated notice — NOT a user message.

Continue from where you stopped. Do not restart.

- If the task is complete: call target_status("done"), then report.
- If waiting for the user: call target_status("awaiting_user"), then close.
- This is not user input and not user approval or consent for any earlier proposal;
  it does not lift any confirmation requirement.

(attempt N in this turn)
```

首段只给"继续"指令，不复述"你未声明就收尾"。把收尾诊断成一次失误，模型会在后续步骤里回避中断（反复补声明、绕开收尾），累积成规避行为并分散注意力；本插件要的是保持推进，不是纠正模型。

截断变体在首段之后追加一句：`Output was cut by the length limit; tool calls after the cut were not executed.`

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

## 8. 对外承诺与开销（2026-11-05 追加）

README 面向使用者，必须说清"保证什么、不保证什么"。这一节是那些表述的设计依据，改动 README 中对应段落时同步这里。

**为什么不承诺正确性**：插件只能观察到"收尾时有没有调用 `target_status`"，观察不到任务是否真的完成。声明是模型自述，不是客观验证。把这一点藏起来、暗示"装了就不会出错"，是最容易招致错误信任的做法。

**为什么接受"可能多一轮"**：收到提醒后，模型需要先声明再汇报，多数场景下会多一次模型请求。这是本设计的固有代价，不是缺陷——换取的收益是"不静默断在半路"。实测 8 次注入全部在 8–19 秒内被响应（中位数约 9.6 秒），说明这个代价在可接受区间。

**为什么系统提示词章节要节流**：章节 324 字符随系统提示词每轮发送。它必须常驻——声明协议若只在需要时注入，模型就无从知道该调用什么。但复述（251 字符）不能常驻，否则等于把章节发两遍；因此按累计遗忘次数节流，每 3 次才出现一次。

**为什么注入文案用常量**：拼接轮次、阈值之类的运行时数据会扩大提示注入面，而对模型没有信息价值。这一条与原则 III 一致，不是省事。

## 9. 错误路径与轮次级恢复（2026-11-05，spec 006）

收尾门只能管正常收尾：`agent/turn-stopping` 在正常路径派发（`dsh-agent-loop/lib/index.js:1001`），
错误路径走 `catch → throwError → agent/error`，根本不进这个钩子。于是上游抖动在重试耗尽后
会让任务停在半路，没有任何自动补救。006 补的就是这一段「重试之后、轮次结束之时」。

**为什么不碰 `agent/request-error`**：那是 `dsh-llm-retry` 的地盘（`dsh-llm-retry/lib/index.js:175`），
它按 provider 的 `retryPolicy` 做退避重试。再挂一个监听器要么和它抢时序，要么把退避逻辑
复制一遍——后者是原则 VII 明确禁止的重复实现。两者回答的是不同问题：它管「单次请求要不要重试」，
本插件管「重试层放弃后还值不值得再给一轮」。

**为什么必须等 `whenIdle`**：`agent/error` 派发时轮次仍是 `running`，此刻 `send` 里
`wakingAfterAbort` 为假、`wakeDriver` 也不置 `wakeRequested`（`dsh-agent-loop/lib/index.js:854-860`），
投递的消息只会躺在队列里等下次用户输入。这条写错时的表现极具迷惑性：监听器确实执行了、
`steer` 确实返回了、日志里什么异常都没有——只是永远不生效。

**为什么用 `steer` 而不是 `followup`**：`followup` 走 `splice("next-turn", Infinity, ...)`，
`Infinity` 被钳到数组长度，落在**队尾**；`steer` 进 `next-step`，而 `claim()` 先取完全部
`next-step` 再取一条 `next-turn`（`dsh-agent-loop/lib/index.js:103-108`），所以同批排队任务里
续行提醒排在最前。产品要求是「注入优先于排队任务」，这是唯一满足它的路径。

**为什么取消判断是防御性的**：取消路径命中 `abortedCancelCause` 后直接 `throw`，
不调用 `throwError`，所以 `agent/error` 根本不会发出（`dsh-agent-loop/lib/index.js:1010-1016`）。
插件仍保留判断，但它防的是未来宿主改动，不是当前链路——相关测试只能写成防御性单测，
不能声称端到端覆盖。

**计数为什么分成两个函数**：`claimResumeTurn` 在决定投递前占轮次，`noteResume` 只在真正
`steer` 之后加一。合成一个的话，要么同一轮触发多次 `agent/error` 时投递两次，
要么被上限挡下的判断也被计入次数——两种都会让上限失真。

## 10. 跨进程守护（2026-11-05，spec 007）

**为什么需要它**：判定状态原本全在 `WeakMap<Agent, …>` 里，每个 DSH 进程各一份。
用户同时开 web 与 CLI 时，遗忘计数被反复清零，阈值（默认 3）永远到不了；
留痕文件 `$DSH_HOME/logs/target-monitor/gate-trace.jsonl` 也被多进程并发追加，
超过 `PIPE_BUF` 的行会交错，事后按行解析直接失败。

**为什么是守护进程而不是文件锁**：Node 没有内置 `flock`，只能用 `mkdir` 自旋模拟，
而自旋锁在进程崩溃后会留下永久锁文件——比多一个进程更难收拾。守护进程还顺带
解决了「单写留痕」：它是唯一写者，天然串行。

**为什么保留双实现**：守护进程是新增故障面（起不来、被强杀、版本不匹配）。
只留远程等于把这些故障放大成「插件整体失效」，比它要解决的问题更糟。
`LocalMonitor` 复用 `gate.ts` 与既有状态模块，行为与引入前逐字一致。

**为什么本地路径必须同步返回**：宿主在收尾钩子返回后立刻检查 `nextStep`。
`LocalMonitor.turnStopping` 返回普通对象而不是 Promise，注入因此仍发生在
监听器返回之前；远程路径返回 Promise，依赖 `dispatch.serial` 的 await
（`dsh-agent-loop/lib/index.js:1001`）。

**为什么宽限 30 秒**：用户常常关一个窗口就开另一个。立刻退出会让守护进程
反复重启，每次重启都要重新建连，反而更慢。

**为什么 `ECONNREFUSED` 不能直接删文件**：守护进程刚 `bind`、还没 `listen`
的窗口里，另一个客户端连上来也会被拒。此时删文件会把正在启动的进程打成孤儿。
实现改为读 pid 文件并用 `signal 0` 二次确认，`EPERM` 视为存活。

**为什么在 `apply` 里预热**：不预热的话，守护进程起不来时第一次轮次收尾
会被 5 秒连接预算卡住——用户看到的是对话卡了 5 秒，而不是插件降级了。

## 11. 设置界面与客户端产物（2026-11-05，spec 008）

**为什么要自建分区**：宿主会把插件配置里的 `volatile` 字段自动生成表单，
但表单只有输入框。008 需要在「关闭初始注入」时同时给出替代方案（写进用户级
`AGENTS.md`）与两个复制按钮，这类说明与动作自动表单承载不了。

**客户端产物的真实格式**：不是 ESM。宿主只服务**已构建**的
`window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`，工厂内部是
CommonJS，依赖经裸模块名从宿主模块表取（`dsh-client-modules/README.md`
「Build requirements」）。缺产物会**启动即失败**，不是静默降级。

**为什么没有引入 bundler**：客户端只有一个文件，包装是纯字符串拼接。
`tsc` 出 CommonJS 后由 `scripts/build-client.mjs` 套包装，比引入 esbuild/tsdown
少一份配置和一个依赖。代价写进了构建脚本：产物一旦出现相对 `require`，
脚本直接报错——因为宿主模块表不解析相对路径，这个错误留到运行期会表现成
"分区没出现"，很难归因。

**为什么复制文本要构建期注入**：设置页复制的规范正文必须与插件真正注入的
逐字一致。让客户端另存一份常量，两边迟早漂移；运行期向宿主请求又需要新接口。
构建脚本从 `dist/prompt.js` 读 `DECLARATION_SECTION` 后写入产物，构建顺序
因此不可颠倒（先服务端、再客户端）。

**为什么关闭开关要连门一起关**：门与上游续行的正文都是"去声明"。没有
`target_status` 时模型无法满足，门只会无限催促——那比不注入更糟。所以
`declarationSection` 为 `false` 时，章节、工具、收尾门、上游续行四者一起停。

**为什么该开关需要重启**：它决定的是"注册什么"，而章节与工具在 `apply` 时
一次性注册，运行中无法撤销。`enabled` 等其余开关只影响判定时的分支，所以仍
即时生效。这个区别写进了 README 的配置表与分区说明，避免"改了没反应"的困惑。

## 12. 设置分区的两处真实缺陷（2026-11-05）

真机渲染暴露了两个**类型检查发现不了**的问题。两者都在 008 的验收阶段才出现，
说明"产物被打包、宿主收录、导航项出现"这一串绿灯不足以证明分区可用。

**注入要写到属性级**。`ctx.remote` 是 typert 的远程代理，`settings` 是它的一个
属性，访问门按属性登记。`inject = ['remote']` 只拿到代理本身，读 `remote.settings`
时抛出 `cannot get property "remote.settings" without inject`。抛出点在组件渲染期，
宿主的 `SlotErrorBoundary` 会捕获并把整条 entry **撤下**（abdicate），于是面板
是一片空白而不是一条错误——控制台只有一行 `slot entry crashed in 'settings.section'`。
正确写法是 `inject = ['remote', 'remote.settings', 'slots']`。

代价与取舍：多写一个字符串，换来"渲染期崩溃"变成"启动期报错"（缺依赖时 cordis
会明确说缺谁）。回归测试直接对 `dist/client.js` 断言 `inject` 含 `remote.settings`——
因为这个问题只有在浏览器里才会炸，而单测跑不到浏览器。

**设置文档只包含 volatile 字段**。`SettingsNamespaceView.value` 里只有
`.volatile()` 声明的键；非 volatile 字段既读不到也写不进。`stallNoticeThreshold`
此前不是 volatile，于是它在分区里永远显示为空，改动也提交不上去。要让它可调，
必须先把它变成 volatile——这不只是 UI 问题，也改变了配置的读取方式
（`snapshot()` 里从直接取值改成 `.get()`）。

因此判断"某个字段能不能在设置页调"，标准不是"它在 schema 里"，而是
"它是不是 volatile"。新增可调字段时，先看这一点。

## 13. 判定类接口不要复用"重复请求返回首次结果"的缓存（2026-11-05）

守护进程给每条请求加了幂等缓存，键是 `(sessionId, turn, type)`，本意是让传输层
重试不产生重复副作用。上线后暴露的问题却是另一个方向：**`turn-stopping` 的答案
本来就是状态的函数**，同一轮会被问很多次——门注入一次、宿主重读 inbox 再跑一步、
轮末再问一次。缓存把第一次的 `inject: true` 原样还给第二次，于是"注入→再收尾→
再注入"，永不停下。

更麻烦的是它**静默**：短路发生在 `dispatch` 之前，连留痕都不写。现场表现是
"每轮收到同一条 `attempt 1` 提醒、留痕文件零新增"，从留痕里查不到任何证据，
只能靠直连 socket 发一条请求、观察文件行数变化才定位到。

判断标准可以写得尽量简单：

- **重复发送应当得到同一结果的**（写：换轮、声明、收尾清理、断开）→ 缓存。
- **答案随状态变化的**（读：收尾判定、上游续行判定、续行确认）→ 不缓存。

更一般的说法：幂等缓存属于**命令**，不属于**查询**。把查询塞进命令的缓存里，
只要状态在两次查询之间变过，就会返回过期答案——而这类接口恰恰最常被重复调用。

代价：判定类请求在传输层重试时会重复计算一次。这些都是纯函数或幂等写，重复计算
不产生副作用，比"返回过期判定"便宜得多。
