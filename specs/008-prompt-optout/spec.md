# Feature Specification: 会话初始注入可选与设置界面接管

**Feature Branch**: `008-prompt-optout`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: 「会话初始注入可选关闭，关闭时设置页建议写入用户级 AGENTS.md，并配两个复制按钮」+ 设计评审补充「设置界面同样迁移为 web 注册方式」「全量接管，含核实写回通道」「确认，那就不修改规范」

## 背景与问题

插件目前**无条件**把声明规范写进系统提示词（`src/prompt.ts` 的 `DECLARATION_SECTION`，324 字符 / 4 行），并在会话一开始就生效。这带来两个问题：

1. **对不需要的人无法关闭**：用户如果自己已经在 `AGENTS.md` 里写了等价约定，这段规范就是重复内容，白占上下文。
2. **设置界面不完全可控**：当前所有配置项依赖宿主 `dsh-settings` 的自动表单（`volatileForm()` 递归收集 `.volatile()` 字段）。它能改值，但没法承载说明文字、后果提示与复制按钮。

本规格把这两件事一起解决：给初始注入一个开关，并把设置界面迁移到自定义分区。

**明确不做**：不修改规范文案本身（用户已确认）。规范正文是既有实现，本规格只决定「注入还是不注入」。（文案后续按用户要求单独修订，见 `CHANGELOG.md` 的 Unreleased。）

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 关闭初始注入后完全静默 (Priority: P1)

用户在自己的 `AGENTS.md` 里已经写了目标状态约定，不想再让插件重复注入。他在设置里关掉「会话初始注入」。之后新开的会话里，系统提示词不含这段规范，模型也看不到 `target_status` 工具；收尾时不再有门禁提醒。

**Why this priority**: 这是本规格的触发点。没有它，其余需求没有存在意义。

**Independent Test**: 关闭开关后新开一个会话，检查该会话的系统提示词全文是否含规范原文、工具列表是否含 `target_status`、以及未声明结束轮次时是否注入。

**Acceptance Scenarios**:

1. **Given** `declarationSection` 为 `true`，**When** 新会话的第一轮开始，**Then** 系统提示词含规范原文，`target_status` 工具可用。
2. **Given** `declarationSection` 为 `false`，**When** 新会话的第一轮开始，**Then** 系统提示词不含规范原文，`target_status` 工具不在工具列表中。
3. **Given** `declarationSection` 为 `false`，**When** 一轮在未声明任何状态的情况下结束，**Then** 不注入自救提醒。
4. **Given** 开关为 `false` 且已有会话正在运行，**When** 用户把开关改回 `true`，**Then** 下一个新会话恢复正常注入；运行中的会话不受影响。

---

### User Story 2 - 设置界面全量接管八个字段 (Priority: P2)

用户打开设置页，看到「Target Monitor」分区，里面有全部七个配置项，每项带一句说明。改动立即生效，不需要重启；两个窗口同时开着改，后提交的一方会收到冲突提示而不是静默覆盖。

**Why this priority**: 开关本身需要落点。放在自动表单里也能用，但没有说明文字与后果提示，用户不知道自己关掉的是什么。

**Independent Test**: 在设置页逐个修改七个字段并刷新，确认值已持久化；同时开两个窗口改同一字段，确认后者收到冲突提示。

**Acceptance Scenarios**:

1. **Given** 设置页已打开，**When** 查看 Target Monitor 分区，**Then** 七个字段全部可见，且每项有说明文字。
2. **Given** 用户修改「遗忘阈值」并保存，**When** 下一次判定发生，**Then** 使用的是新阈值，无需重启。
3. **Given** 两个窗口同时打开设置页，**When** 都修改同一字段并先后提交，**Then** 后提交者看到冲突提示，页面重新加载为最新值。
4. **Given** 宿主设置为只读（`writable` 为假），**When** 打开该分区，**Then** 控件为禁用状态并给出说明，而不是允许编辑后静默失败。

---

### User Story 3 - 关闭时给出替代方案与复制按钮 (Priority: P3)

用户在设置里关掉初始注入后，分区下方出现一段说明：建议把规范写进用户级 `AGENTS.md`，这样所有项目都能生效。旁边有两个按钮：一个复制规范正文，一个复制带规范的完整指令。

**Why this priority**: 关掉注入之后，用户如果什么都不做，就等于彻底失去这套约定。这段提示把「关闭」变成「迁移」，而不是「放弃」。

**Independent Test**: 关闭开关，确认提示区出现；点击两个按钮，确认剪贴板内容分别为规范正文与带规范的指令，且内容与插件实际注入的文本逐字一致。

**Acceptance Scenarios**:

1. **Given** `declarationSection` 为 `true`，**When** 查看分区，**Then** 提示区不显示（避免噪声）。
2. **Given** `declarationSection` 为 `false`，**When** 查看分区，**Then** 提示区显示，包含目标文件路径建议与两个按钮。
3. **Given** 点击「复制规范」，**When** 检查剪贴板，**Then** 内容与 `DECLARATION_SECTION` 逐字一致（含标点与换行）。
4. **Given** 点击「复制指令」，**When** 检查剪贴板，**Then** 内容包含一句面向模型的操作指令与完整规范正文，可直接粘贴进 `AGENTS.md`。

---

### Edge Cases

- **客户端 bundle 加载失败**：宿主仍会用自动表单渲染 volatile 字段，配置可改，只是没有说明文字与复制按钮；插件功能不受影响。
- **关闭开关时正有一轮在运行**：该轮仍按旧行为走完（已注册的章节与工具不会中途消失），下一轮或下一会话生效。
- **开关关闭后又开启**：恢复注入，遗忘计数与续行计数不清零（它们是独立状态）。
- **`target_status` 工具被外部原因禁用**（例如工具过滤）：收尾门仍会催促。这属于既有行为，本规格不改变，但在设置页说明中标注。
- **复制按钮在没有剪贴板权限的环境**：提示复制失败，并展示可选中的文本框作为兜底。
- **设置值非法**（例如阈值为 0 或负数）：保存时拒绝并提示，不写入。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 插件 MUST 提供布尔配置项 `declarationSection`，默认 `true`，且 MUST 为可运行时修改（volatile）。
- **FR-002**: `declarationSection` 为 `false` 时，插件 MUST NOT 注册声明规范章节。
- **FR-003**: `declarationSection` 为 `false` 时，插件 MUST NOT 注册 `target_status` 工具。
- **FR-004**: `declarationSection` 为 `false` 时，插件 MUST NOT 执行收尾门判定与注入（没有声明通道时保留门禁只会无限催促一个无法满足的条件）。
- **FR-005**: `declarationSection` 为 `false` 时，插件 MUST NOT 执行上游续行的投递（它与收尾门共用同一条自救通道，且依赖 `target_status` 收尾）。
- **FR-006**: 开关变化 MUST 只影响此后新建立的注册与新开始的轮次，MUST NOT 中断正在进行的轮次。
- **FR-007**: 插件 MUST 注册一个自定义设置分区（`settings.section`，id 为 `target-monitor`），承载全部配置项。
- **FR-008**: 该分区 MUST 展示八个字段：`enabled`、`stallNoticeThreshold`、`reminderThreshold`、`reactionWindowMs`、`resumeOnUpstreamError`、`maxResumes`、`declarationSection`、`crossProcess`。
  - 实现说明：宿主只把 `.volatile()` 字段交给设置文档（`dsh-settings/README.md`「Forms expose only volatile fields」），因此 `stallNoticeThreshold` 也改为 volatile，否则它既不出现在 `value` 里、也无法从界面写入；`crossProcess` 是 007 引入的第八个开关，原规格写作七项时尚未存在。
- **FR-009**: 每个字段 MUST 附带一句说明，说明其作用与影响范围。
- **FR-010**: 修改 MUST 通过宿主的设置写回接口完成，写入时 MUST 携带读取时取得的 revision。
- **FR-011**: 写入冲突时 MUST 提示用户并重新加载为最新值，MUST NOT 静默覆盖他人修改。
- **FR-012**: 宿主设置为只读时，分区 MUST 呈现为禁用并说明原因，MUST NOT 允许编辑后静默失败。
- **FR-013**: 非法值 MUST 在写入前被拒绝并给出提示，不得落到配置里。
- **FR-014**: `declarationSection` 为 `false` 时，分区 MUST 显示替代方案提示，建议把规范写入用户级 `AGENTS.md`，并给出建议路径。
- **FR-015**: 分区 MUST 提供两个复制动作：复制规范正文、复制带规范的完整指令；两者内容 MUST 与插件实际使用的文本逐字一致。
- **FR-016**: 复制动作 MUST 有失败兜底：剪贴板不可用时展示可选中文本。
- **FR-017**: 客户端资源加载失败时，插件 MUST 保持其余功能可用；配置仍可通过宿主自动表单修改。
- **FR-018**: 本规格 MUST NOT 修改规范正文与提醒文案的任何字符。

### Key Entities

- **SettingField**: 一个可编辑配置项，属性为键名、类型、默认值、说明文字、取值范围。
- **SettingsSection**: 自定义分区，属性为 id、标题、字段列表、只读状态、冲突状态。
- **CopyAction**: 一个复制动作，属性为标签、要复制的文本、失败兜底内容。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 关闭开关后新开会话，系统提示词中规范原文出现次数为 0，工具列表中 `target_status` 出现次数为 0。
- **SC-002**: 关闭开关后，未声明轮次结束时的注入次数为 0；开启后恢复为每次注入 1 条。
- **SC-003**: 设置页七个字段全部可见，修改任意一项后无需重启即生效（下一次判定使用新值）。
- **SC-004**: 并发修改同一字段时，后提交者 100% 收到冲突提示，不出现静默丢失。
- **SC-005**: 两个复制动作的内容与插件内部常量逐字一致（逐字符比较通过）。
- **SC-006**: 客户端资源加载失败时，插件的注入与判定功能回归测试全绿。

## Assumptions

- 宿主提供 `ctx.settings.describe/update`，且支持 revision 冲突检测（已在 `dsh-settings/lib/types/index.d.ts` 核实）。
- 宿主支持客户端插件与 `settings.section` 插槽（已在 `billion-context` 的 `src/agent/dsh-native-client.ts` 核实）。
- 客户端 bundle 的构建与加载方式尚未验证：本项目目前只有 `tsc`。若宿主不能直接加载 ESM 产物，需要在计划阶段引入打包步骤。
- 自定义分区与宿主自动表单可能同时出现（自动表单按 volatile 字段生成）；是否需要抑制自动表单，在计划阶段核实。
- 用户级 `AGENTS.md` 路径按 `~/.dsh/AGENTS.md` 给出建议，实际是否被宿主加载由用户的 profile 决定。
