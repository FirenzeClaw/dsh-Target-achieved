# DSH-Target-achieved

为 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的**收尾门**：任务尚未完成却要静默收尾时，自动注入一条自救提醒，要求模型「继续」或「声明完成并汇报」。

## 要解决的问题

| 故障 | 由谁负责 | 本插件 |
|---|---|---|
| 任务中途收尾（模型以为自己说完了） | **本插件** | 在 `agent/turn-stopping` 拦截：未声明目标状态就不放行 |
| 输出被长度上限截断 | **本插件** | 识别 `max-tokens`，提醒"截断后的工具调用未执行" |
| 上游断流 / 限流 | 宿主 `agent/request-error` | **不重复实现**（FR-013） |
| 思考泄露 / 工具调用畸形 | 流式层与工具层 | **不在范围内**（F1/F2） |

一句话：**只做收尾门，不做重试器、不做内容质检器。**

## 工作方式

1. 系统提示词常驻一节，要求模型在收尾前调用 `target_status("done")` 或 `target_status("awaiting_user")`。
2. 轮次即将关闭时，插件检查本轮状态：
   - 已声明 → 放行；
   - 未声明 → 注入一条归属 `target-monitor` 的自救提醒，并让轮次继续。
3. 提醒显式声明**它不是用户消息、不构成任何授权**，并给「我在等用户确认」留出口。
4. 同一轮第 5 次仍未声明 → 向用户发一条"可能卡住"的提示（每轮仅一次）。
5. **跨轮累计**：注入后 30 秒内声明成功即记一次"遗忘"；累计 3 次后，下一次提醒的正文末尾追加一段声明规范复述，发完清零。真中断（收到提醒后始终没声明）不计数也不清零——否则长任务永远到不了阈值。
6. 用户取消 → 本轮绝不复活；下一次输入自动恢复门控。

状态只存内存，按「顶层 agent × 轮次」定位，跨轮自动回到进行中。子 agent 不设门。

## 治理边界：它管什么，不管什么

**治理对象只有一个**：单次轮次的收尾动作是否附带一次显式的目标状态声明。除此之外的一切都不在管辖范围内。

| 管 | 不管 |
|---|---|
| 顶层 agent 的轮次收尾 | 子 agent 的轮次（`ctx.agents.roots()` 之外一律不管） |
| 收尾时是否有过 `target_status` 调用 | 任务是否**真的**完成——那是模型的判断，插件无从验证 |
| `stop` 与 `max-tokens` 两种结束原因 | `aborted` / `error`：交给宿主的 `agent/request-error`，**不重复实现**（FR-013） |
| 未声明时注入一条固定提醒 | 模型是否照做；注入可能被忽略 |
| 累计遗忘次数、周期性复述规范 | 思考泄露、工具调用畸形等流式层与工具层问题（F1/F2） |

### 它明确不承诺的事

这个插件是**减损装置，不是正确性保证**。使用者应当知道：

1. **声明是模型自述，不是客观验证。** 插件只能检查「有没有声明」，不能检查「声明得对不对」。模型判断失误、在任务未完成时声明 `done`，插件会照常放行。
2. **注入可能被忽略。** 模型收到提醒后仍可再次不声明就收尾；同一轮内没有硬性上限（当前策略是不设上限、第 5 次向用户发一次提示）。插件保证的是"不静默放行"，不是"一定会继续干"。
3. **依赖宿主内部契约。** 判定建立在 `agent/turn-stopping`、`agent/assistant-stream` 等事件的当前形态上（按 `0.2.1-rc.5` 核实）。宿主升级后这些契约可能变化，需要重新核对——`AGENTS.md` 的「宿主事实速查」记录了依赖点。
4. **不复活被取消的轮次。** 用户取消即结束，这是刻意的：自动复活用户已经叫停的东西，比静默中断更糟。
5. **不保证省 token。** 见下一节——它用少量额外开销换取"不静默断在半路"。

## 开销：多出来的那一点

诚实地说清楚代价，因为它是真实存在的。

**每次轮次收尾的固定开销**是系统提示词里的声明协议章节，**433 字符**（4 行，约 110–160 token）。它随系统提示词发送；同一会话内前缀稳定，可被 prompt cache 复用，实际边际成本通常低于字面估计。

**每次未声明收尾**会注入一条提醒，**647 字符**（13 行，约 170–220 token）。若恰逢累计遗忘达到阈值，再追加一段规范复述，**306 字符**（约 80–100 token）——每累计 3 次遗忘才出现一次。

**但真正的成本不是这几百字，而是"多一轮"。** 模型收到提醒后要先调用 `target_status` 再汇报，多数场景下这会多一次模型请求，也就是多一轮推理与工具往返。实测 8 次注入全部在 8–19 秒内被响应（中位数约 9.6 秒），这段时间就是额外的墙钟开销。

设计上对开销做了三处收敛：

- 只有**未声明**才注入，已声明的轮次零额外开销；
- 同一轮第 5 次仍未声明才向用户发提示，且**每轮只发一次**；
- 复述按累计次数节流，正常使用的模型几乎碰不到。

**什么时候不该用它**：如果任务天然是短会话、一次性问答，收尾门带来的收益（避免半路中断）可能小于固定开销。它更适合长任务、多步实现、需要收尾汇报的场景。

## 使用

```bash
npm install
bash scripts/link-host.sh     # 开发期链接宿主已安装的 @deepseek-ai 包
npm run typecheck && npm test && npm run build
```

挂载到 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: target-monitor
      name: 'dsh-target-monitor'
      config:
        enabled: true
        stallNoticeThreshold: 5
```

配置非法值会在启动时抛出，不会静默回退。

### 安装

三种方式，任选其一：

```bash
# 1. 作为 bundle（安装器会读取 dsh.bundle.patch 并写入 profile 补丁层）
dsh plugin --profile web add dsh-target-monitor

# 2. 从 git 源
dsh plugin --profile web add git+ssh://git@github.com/FirenzeClaw/dsh-Target-achieved.git

# 3. 本地开发（link:）
dsh plugin --profile web add /path/to/DSH-Target-achieved
```

### 设置页

以下字段声明为 **volatile**，会出现在宿主的插件设置页里，改动后**立即生效**（不重挂载）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭时判定直接放行，工具拒绝声明 |
| `reminderThreshold` | `3` | 累计几次遗忘后复述一次声明规范 |
| `reactionWindowMs` | `30000` | 注入后多久内的声明算作"被提醒才想起来" |

`stallNoticeThreshold`（向用户发"可能卡住"提示的阈值，默认 5）目前**不在设置页暴露**，只能通过 `cordis.patch.yml` 修改：它参与告警节奏，热改语义尚未验证，待真实会话验证后再开放。

非法值在设置页保存时即被拒绝，错误信息带字段名，不会静默回退默认值。

## 判定留痕

每次收尾判定都会落一条记录，**放行也记**——否则"没注入"与"没运行"无法区分（曾据此误判出一个并不存在的缺陷）。

```bash
# 某一轮的全部判定
jq -c 'select(.turn == 7)' ~/.dsh/logs/target-monitor/gate-trace.jsonl
```

字段：`at` / `session`（8 位短哈希）/ `turn` / `outcome`（`injected` | `released`）/ `reason` / `attempt`。

`reason` 覆盖六种出口：`undeclared`、`declared`、`disabled`、`not-root`、`aborted`、`error`。**某轮查不到记录才说明该轮未被判定。**

记录绝不进入模型可见面：不提供查询工具（工具结果会进模型上下文），只写文件与内存缓冲。单文件超 2 MiB 轮转为 `.1`，只保留两代。

## 当前状态

**已在真实会话中验证**：三种状态（未声明 → 注入；声明 `done` → 不注入；声明 `awaiting_user` → 不注入）、轮次键对齐、注入有效性（8 次注入全部在 8–19 秒内被响应）。

测试 97 项全通过，`typecheck` 与 `build` 均通过。005（复述）与 004 的留痕、设置页、打包元数据已实现；004 的市场清单发布流程待定。

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/PLUGIN-DESIGN.md`](docs/PLUGIN-DESIGN.md) | 设计取舍、职责边界、风险与未决 |
| [`specs/001-target-monitor/spec.md`](specs/001-target-monitor/spec.md) | 需求与验收标准（17 FR / 7 SC） |
| [`specs/001-target-monitor/plan.md`](specs/001-target-monitor/plan.md) | 技术方案与宪法检查 |
| [`specs/001-target-monitor/tasks.md`](specs/001-target-monitor/tasks.md) | 46 个任务及完成状态 |
| [`specs/004-observability-and-packaging/`](specs/004-observability-and-packaging/) | 留痕、设置页、可分发（16 FR / 7 SC） |
| [`specs/005-declaration-reminder/`](specs/005-declaration-reminder/) | 声明规范复述 |
| [`AGENTS.md`](AGENTS.md) | 项目上下文、宿主事实速查、编码约定 |

## 目录

```
src/                    插件实现（入口 / 配置 / 状态 / 判定 / 工具 / 文案 / 计数 / 留痕）
tests/                  单元与集成测试（node --test）
scripts/link-host.sh    开发期链接宿主包
docs/ specs/ .specify/  设计、规格与 speckit 脚手架
dsh.bundle.patch        bundle 补丁：安装器据此把插件写进 profile
```

## 许可

[MIT](LICENSE) © 2026 FirenzeClaw

任何人都可以自由使用、修改、再分发，包括商业用途；唯一要求是保留版权声明与许可声明。软件按「现状」提供，不附带任何明示或暗示的担保——包括但不限于适销性与特定用途适用性。因使用本软件产生的任何索赔、损害或其他责任，作者与版权持有人概不负责。

对本项目而言，这条免责声明有具体含义：插件依赖 DeepSeek-Harness 的内部事件契约，**宿主升级后可能失效**；它也是减损装置而非正确性保证（见上文「治理边界」）。用于关键流程前，请自行在目标版本上验证。
