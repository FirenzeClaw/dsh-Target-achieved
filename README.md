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
5. 用户取消 → 本轮绝不复活；下一次输入自动恢复门控。

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

## 当前状态

**M1 已实现**：`src/` 8 个模块、`tests/` 43 项测试全通过、`typecheck` 与 `build` 均通过。

**尚未验证**：以上全部基于单元测试与宿主替身，**没有在真实会话中跑通过**。最关键的待验证前提是「在 `agent/turn-stopping` 内 `steer` 能让轮次继续」——若该假设失效，整个方案需要退回"轮次结束后 followup"的形态。详见 [`specs/001-target-monitor/quickstart.md`](specs/001-target-monitor/quickstart.md) 的 S1–S6 场景。

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/PLUGIN-DESIGN.md`](docs/PLUGIN-DESIGN.md) | 设计取舍、职责边界、风险与未决 |
| [`specs/001-target-monitor/spec.md`](specs/001-target-monitor/spec.md) | 需求与验收标准（17 FR / 7 SC） |
| [`specs/001-target-monitor/plan.md`](specs/001-target-monitor/plan.md) | 技术方案与宪法检查 |
| [`specs/001-target-monitor/tasks.md`](specs/001-target-monitor/tasks.md) | 46 个任务及完成状态 |
| [`AGENTS.md`](AGENTS.md) | 项目上下文、宿主事实速查、编码约定 |

## 目录

```
src/                    插件实现（入口 / 状态 / 判定 / 工具 / 文案 / 来源）
tests/                  单元与集成测试（node --test）
scripts/link-host.sh    开发期链接宿主包
docs/ specs/ .specify/  设计、规格与 speckit 脚手架
```
