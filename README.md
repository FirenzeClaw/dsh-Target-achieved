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

测试 95 项全通过，`typecheck` 与 `build` 均通过。005（复述）与 004 的留痕、设置页、打包元数据已实现；004 的市场清单发布流程待定。

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
src/                    插件实现（入口 / 状态 / 判定 / 工具 / 文案 / 来源）
tests/                  单元与集成测试（node --test）
scripts/link-host.sh    开发期链接宿主包
docs/ specs/ .specify/  设计、规格与 speckit 脚手架
```
