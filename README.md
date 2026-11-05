# DSH-Target-achieved

为 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) 设计的目标达成插件：**当任务尚未完成却要静默收尾时，主动续行或要求交代**，避免思考泄露、输出格式异常、上游断流导致的"看起来结束了、其实没做完"。

## 要解决的问题

| 故障 | 现状 | 本插件的处理 |
|---|---|---|
| 任务中途收尾（模型以为自己说完了） | 无任何拦截，轮次直接关闭 | 在 `agent/turn-stopping` 拦截并带证据续行 |
| 上游断流 / 限流 | 宿主 `agent/request-error` 已有请求级重试 | 不重复实现；只在重试耗尽且任务未完成时补一次恢复 |
| 思考泄露 / 工具调用畸形 | 无语义检测 | 独立切片，接点在流式与工具层（见设计文档） |

## 当前状态

**仅完成项目引导，尚无实现代码。** 仓库内已有：speckit 脚手架（`.specify/`）、项目宪法（`.specify/memory/constitution.md`）、项目级上下文（`AGENTS.md`）、代码索引（`.codegraph/`）。

设计与宿主事件面调研见 [`docs/PLUGIN-DESIGN.md`](docs/PLUGIN-DESIGN.md)。

## 下一步

1. `git init` + 首次提交（尚未初始化仓库）
2. `/speckit-specify` 把设计草案收敛成可验收的规格
3. 按设计文档 §7 的 M1 切片实现：系统提示词章节 + `target_status` 工具 + 收尾门 + 预算

## 目录

```
AGENTS.md                    项目级上下文（技术栈、宿主事实速查、编码约定）
docs/PLUGIN-DESIGN.md        设计取舍、方案对比、风险、未决问题
.specify/                    speckit 脚手架与项目宪法
.dsh/skills/                 speckit-* 技能
.codegraph/                  代码索引
```
