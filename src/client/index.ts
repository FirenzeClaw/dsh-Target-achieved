/**
 * 浏览器端客户端插件：接管「设置 → DSH中断续行」分区。
 *
 * 为什么需要它：宿主只把 `.volatile()` 字段交给自动表单，且自动表单无法承载
 * 「关闭初始注入后给出 AGENTS.md 建议 + 复制按钮」这类交互。自定义分区可以把
 * 八个字段与建议放在同一页，并按 revision 做冲突检测。
 *
 * 视觉口径：本页与宿主「设置 → 通用设置 / 内置插件」同语言，而不是另起一套。
 * 实测（0.2.1-rc.5）宿主分区的口径为——标题 18px/600，说明 13px 且用
 * `--dsw-alias-label-tertiary`，标题与说明间距 12px；设置行上下 16px、行间
 * 1px `--dsw-alias-border-l2` 分隔；行标签 14px/400 `--dsw-alias-label-primary`，
 * 说明 12px/18px `--dsw-alias-label-secondary`；开关 36×20 圆角胶囊。
 * 控件直接用宿主原语（`Switch` / `Input` / `Button`），它们的 hover、focus-visible
 * 与暗色主题由宿主 CSS 负责，本文件不复制一份。
 *
 * 为什么不用 `SettingsForm`：那套是「暂存草稿 + 保存」的插件卡片，字段规格只有
 * 文本与数字两种，没有布尔；本页五个布尔开关按设置页习惯即时生效，与草稿模型
 * 混用会让同一页出现两套提交语义。
 *
 * 构建约束（见 scripts/build-client.mjs）：本文件必须**自包含**，不得有相对 import
 * ——宿主模块表只解析裸模块名。React、react/jsx-runtime 与 ui-primitives 由宿主提供。
 *
 * 因此本文件超过 AGENTS.md 的 400 行建议上限，且 `TargetMonitorSection` 超过 50 行：
 * 客户端产物由 `tsc` 直出、不经 bundler 合并，拆成多文件就无法构建。这是「单文件
 * 产物」约束下的既有例外，不是遗漏；要拆必须先改构建链。
 */

import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

/** 构建期注入：规范正文与 AGENTS.md 片段，来自宿主侧 src/prompt.ts，避免两处漂移。 */
declare const __TM_DECLARATION_TEXT__: string
declare const __TM_AGENTS_SNIPPET__: string

export const name = 'target-monitor-client'
/**
 * 依赖声明。
 *
 * `remote.settings` 必须**单独列出**：`ctx.remote` 是 typert 的远程代理，每个属性
 * 有独立的访问门。只注入 `remote` 时，`ctx.remote.settings` 在读取那一刻抛出
 * `cannot get property "remote.settings" without inject`；抛出点在组件渲染期，
 * 宿主会把整条 section 判为崩溃并撤下——面板一片空白，控制台只有一行
 * `slot entry crashed in 'settings.section'`。类型检查发现不了这个错，所以留注释。
 */
export const inject = ['remote', 'remote.settings', 'slots']

/** 宿主 Remote 的返回形状：成功带 value，失败带 error。 */
type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteFailure }

interface RemoteFailure {
  readonly code?: string
  readonly message?: string
}

/** 一个 profile 插件条目的设置视图；只声明本文件用到的字段。 */
interface SettingsNamespaceView {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
}

interface SettingsDescribeValue {
  readonly writable: boolean
  readonly namespaces: readonly SettingsNamespaceView[]
}

interface SettingsRemote {
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
  update(
    ns: string,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<RemoteResult<SettingsNamespaceView>>
}

/** 客户端上下文的最小结构；完整契约由宿主提供，这里只取用到的两个服务。 */
interface ClientContext {
  readonly remote: { readonly settings: SettingsRemote }
  readonly slots: {
    inject(name: string, register: () => () => void): void
    register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): () => void
  }
}

/** profile 里本插件条目的 id；见 `dsh.bundle.patch` 与 `cordis.patch.yml` 的 insert 条目。 */
const NAMESPACE_ID = 'target-monitor'

type FieldKind = 'boolean' | 'number'

interface FieldSpec {
  readonly key: string
  readonly kind: FieldKind
  readonly label: string
  readonly hint: string
  /**
   * 数字字段的取值约束；与宿主侧 `src/config.ts` 逐条对应。
   * `integer: false` 的字段（毫秒数）允许小数，其余必须是整数。
   */
  readonly rule?: {
    readonly min: number
    readonly max: number
    readonly integer: boolean
    /** 该值被谁消费、多少才算得着——用来解释「填太大就永远不会触发」。 */
    readonly reachNote: string
  }
}

/**
 * 字段清单与顺序。
 *
 * 排序规则：**开关在前、输入项在后**。开关是"这条路开不开"，输入项是"开了之后
 * 怎么调"，先说开不开才不显得在问用户一个还没生效的参数。同组内按因果链排：
 * 全局（声明规范 → 收尾门）→ 跨进程 → 续行（开关 → 它的次数上限）→ 收尾门的
 * 三个阈值（提示 → 复述 → 响应窗口）。
 *
 * 默认值与语义以宿主侧 `src/config.ts` 为准；`rule` 是它校验规则的镜像，两侧
 * 任一改动都要同步，否则界面会放行一个宿主必然拒绝的值。
 */
const FIELDS: readonly FieldSpec[] = [
  {
    key: 'declarationSection',
    kind: 'boolean',
    label: '会话开始时注入声明规范',
    hint: '只控制系统提示词章节是否注入；target_status 工具、收尾门与上游续行都照常工作。关闭后请把下方片段写进用户级 AGENTS.md 承载规范。此项决定注册内容，改动需「重启 DSH」生效',
  },
  {
    key: 'enabled',
    kind: 'boolean',
    label: '启用收尾门',
    hint: '关闭后轮次收尾不做判断，也不注入提醒',
  },
  {
    key: 'crossProcess',
    kind: 'boolean',
    label: '跨进程共享状态',
    hint: '交给本机守护进程，多个 DSH 实例共享计数；守护进程不可用时自动退回进程内。此项决定启动期的 socket 连接，改动需「重启 DSH」生效',
  },
  {
    key: 'resumeOnUpstreamError',
    kind: 'boolean',
    label: '上游异常自动续行',
    hint: '上游可重试错误耗尽后，自动续行一轮。关闭后「单轮内上游异常最大续行次数」不再生效',
  },
  {
    key: 'maxResumes',
    kind: 'number',
    label: '单轮内上游异常最大续行次数',
    hint: '同一轮最多连续续行几次；0 表示不续行',
    rule: {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
      reachNote: '只在上游可重试错误（限流、超时、服务端错误、空响应）耗尽后才会用到',
    },
  },
  {
    key: 'stallNoticeThreshold',
    kind: 'number',
    label: '卡住提示阈值',
    hint: '同一轮被注入多少次后，向你发一次「可能卡住」提示',
    rule: {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
      reachNote: '阈值高于实际注入次数就永远不会提示（提示每轮最多一次）；同一轮注入不设硬上限，通常 3～5 次就够',
    },
  },
  {
    key: 'reminderThreshold',
    kind: 'number',
    label: '规范复述阈值',
    hint: '累计多少次「提醒后才补声明」之后，在下一次提醒末尾复述一遍规范',
    rule: {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
      reachNote: '这是跨轮累计的遗忘次数，不是单轮次数',
    },
  },
  {
    key: 'reactionWindowMs',
    kind: 'number',
    label: '响应窗口（毫秒）',
    hint: '注入后多久内完成声明算一次「遗忘」',
    rule: {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
      reachNote: '窗口越长，越少被算作「遗忘」，复述也就越少出现',
    },
  },
]

/**
 * 宿主设置页的排版尺度。
 *
 * 数值取自宿主 `0.2.1-rc.5` 实测：标题块（「设置 → 内置插件」的 `h2`）18px/600、
 * 说明 13px/label-tertiary、标题块间距 12px；设置行（「通用设置」的 `.row`）上下
 * 16px、行间 1px `--dsw-alias-border-l2`、行标签 14px/400、行说明 12px/18px。
 * 这套口径来自宿主的 CSS module，宿主升级不会报错也不会被测试发现——升级宿主时
 * 需按本节注释重新量一遍。
 */
const HEADER_GAP = '12px'
const ROW_PADDING_Y = '16px'

/** 数字输入框宽度：容得下 6 位数字（`reactionWindowMs` 的 30000）而不抢行走说明列。 */
const NUMBER_INPUT_WIDTH = '96px'

/** 规范正文预览的最大高度：超过就内部滚动，避免把八个字段挤出视野。 */
const CODE_MAX_HEIGHT = '150px'

/** 复制反馈的停留时长。 */
const COPY_FEEDBACK_MS = 1500

const headingStyle = {
  margin: 0,
  fontSize: '18px',
  fontWeight: 600,
  lineHeight: '26px',
  color: 'var(--dsw-alias-label-primary)',
}

const descriptionStyle = {
  margin: 0,
  fontSize: '13px',
  lineHeight: '19px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const labelStyle = {
  fontSize: '14px',
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
}

const hintStyle = {
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const codeStyle = {
  margin: 0,
  maxHeight: CODE_MAX_HEIGHT,
  overflow: 'auto',
  padding: '10px 12px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-sm)',
  background: 'var(--dsw-alias-bg-layer-1)',
  // 宿主没有等宽字体令牌（`--dh-font-family-code` 在运行时为空），这里用它自己的
  // 代码字体栈，与宿主渲染代码块时一致。
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
}

/**
 * 从设置视图里认出本插件的命名空间。
 *
 * 主路径按 `ns` 精确匹配 profile 里的条目 id（`target-monitor`），因为它由
 * `cordis.patch.yml` 的 insert 条目决定、不会随字段增减变化；末尾匹配用于容忍
 * 用户把条目改成带前缀的写法。特征字段只作兜底——实测 `value` 里**不含**
 * `stallNoticeThreshold`（该字段没有 schema 默认值，未显式配置时整键缺省），
 * 所以不能拿它当唯一判据。
 */
function findNamespace(namespaces: readonly SettingsNamespaceView[]): SettingsNamespaceView | undefined {
  const exact = namespaces.find((view) => view.ns === NAMESPACE_ID)
  if (exact !== undefined) return exact
  const suffixed = namespaces.find((view) => view.ns.endsWith(`-${NAMESPACE_ID}`) || view.ns.endsWith(`/${NAMESPACE_ID}`))
  if (suffixed !== undefined) return suffixed
  return namespaces.find((view) => {
    const value = view.value
    return typeof value === 'object' && value !== null && 'stallNoticeThreshold' in value
  })
}

function readField(view: SettingsNamespaceView, key: string): unknown {
  const value = view.value
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/**
 * 把宿主返回的失败翻译成用户能读懂的一句。
 *
 * 冲突单独说（因为接下来会自动重读重试），其余保留原始码做括号补充——排查时
 * 需要它，但把 `settings/rejected: ...` 直接甩到界面上不是给人看的。
 */
function failureText(failure: RemoteFailure): string {
  if (isConflict(failure)) return '配置已被其他窗口修改，已刷新为最新值，请再改一次'
  const code = failure.code ?? 'unknown'
  const message = failure.message ?? ''
  const detail = message === '' ? code : `${code}: ${message}`
  return `宿主没有接受这次修改（${detail}）`
}

/**
 * 判断写入失败是不是 revision 冲突。
 *
 * 实测宿主返回的码是 `settings/conflict`（小写、带前缀），而不是文档里写的
 * `SETTINGS_CONFLICT`；两种写法都要认，否则用户看到的是一条原始英文码。
 */
function isConflict(failure: RemoteFailure): boolean {
  const code = (failure.code ?? '').toLowerCase()
  return code.includes('conflict')
}

/** 卡片内的一行：左侧标签与说明，右侧控件；行间用宿主设置页的 1px 分隔线。 */
function SettingRow(props: {
  /** 数字行传输入框 id，用 `<label for>` 建立关联；开关行没有可关联的控件。 */
  readonly htmlFor?: string
  readonly label: string
  readonly hint: string
  readonly hintId: string
  readonly hintTone?: 'default' | 'invalid'
  readonly last?: boolean
  readonly control: unknown
}): unknown {
  const hint = {
    ...hintStyle,
    ...(props.hintTone === 'invalid' ? { color: 'var(--dsw-alias-state-error-primary)' } : null),
  }
  // 开关是 <button role=switch>，`<label for>` 指向不了它；那种行用 span，
  // 否则会留下一个点不动的空标签，读屏还会把它念成表单标签。
  const labelProps = {
    htmlFor: props.htmlFor,
    style: labelStyle,
    children: props.label,
  }
  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '24px',
      padding: `${ROW_PADDING_Y} 0`,
      borderBottom: props.last === true ? 'none' : '1px solid var(--dsw-alias-border-l2)',
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
        children: [
          props.htmlFor === undefined ? jsx('span', labelProps) : jsx('label', labelProps),
          jsx('span', { id: props.hintId, style: hint, children: props.hint }),
        ],
      }),
      props.control,
    ],
  })
}

/**
 * 布尔开关：点击即写，同时先按用户意图显示。
 *
 * 为什么是乐观显示：实测宿主 `settings.update` 从发出到界面拿到新值约 1.5 秒
 * （写入经设置文档的监听发布后才回到客户端）。按服务端结果渲染会让开关在点击后
 * 一秒半里保持原样，用户以为没点中，往往再点一次——那才是真的写错。
 */
function ToggleRow(props: {
  readonly field: FieldSpec
  readonly value: unknown
  readonly disabled: boolean
  readonly last: boolean
  readonly hintId: string
  /** 本字段写入失败的次数；只有本字段的计数会变，不影响其它字段。 */
  readonly resetToken: number
  readonly onChange: (key: string, next: boolean) => void
}): unknown {
  const stored = props.value === true
  const [pending, setPending] = useState<boolean | undefined>(undefined)
  // 服务端值追上了乐观值就清掉草稿；写入失败由 resetToken 兜底撤回。
  useEffect(() => {
    if (pending !== undefined && pending === stored) setPending(undefined)
  }, [stored, pending])
  useEffect(() => {
    setPending(undefined)
  }, [props.resetToken])

  return jsx(SettingRow, {
    label: props.field.label,
    hint: props.field.hint,
    hintId: props.hintId,
    last: props.last,
    control: jsx(Switch, {
      checked: pending ?? stored,
      disabled: props.disabled,
      label: props.field.label,
      // 宿主 Switch 的 props 是封闭解构（不接受 aria-describedby），说明文字只能
      // 走 title；键盘聚焦时浏览器会显示提示，读屏则至少能拿到可访问名。
      title: props.field.hint,
      onChange: (next: boolean) => {
        setPending(next)
        props.onChange(props.field.key, next)
      },
    }),
  })
}

/**
 * 数字字段：本地草稿 + 失焦/回车提交。
 *
 * 为什么不是逐键写入：每次按键都是一次带 revision 的文档写入，输入「30000」会
 * 连写五次，中途的 3、30、300 都会被当成配置落盘；一旦某次落在非法值上，宿主
 * 侧的 `src/config.ts` 会整条 entry 判为 inactive。草稿把「用户还在打字」与
 * 「用户定了这个值」分开，非法草稿不提交，失焦即还原。
 */
function NumberRow(props: {
  readonly field: FieldSpec
  readonly value: unknown
  readonly disabled: boolean
  readonly last: boolean
  readonly inputId: string
  readonly hintId: string
  /** 本字段写入失败的次数；只有本字段的计数会变，不影响其它字段的草稿。 */
  readonly resetToken: number
  readonly onCommit: (key: string, next: number) => void
}): unknown {
  const stored = typeof props.value === 'number' && Number.isFinite(props.value) ? String(props.value) : ''
  const [draft, setDraft] = useState(stored)
  /**
   * 提交后紧跟的 blur 要跳过。
   *
   * `el.blur()` 会**同步**派发 blur，React 的 `onBlur` 随即执行；而 `setDraft` 只是
   * 排队。所以「Escape 还原后 blur」若被 onBlur 再提交一次，提交的是用户刚想放弃的
   * 旧草稿——取消变成了保存。Enter 同理，会多写一次同值。
   */
  const skipBlurRef = useRef(false)

  // 外部值变化（提交成功、其他窗口改写、本字段写入失败）时回填；草稿本身由用户编辑驱动。
  useEffect(() => {
    setDraft(stored)
  }, [stored, props.resetToken])

  // `kind === 'number'` 才渲染本组件，规格一定在；缺省按最保守的 0 兜底而不是 crash。
  const rule = props.field.rule ?? { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, reachNote: '' }
  const trimmed = draft.trim()
  // 只接受十进制数字串：`Number('0x10')`、`Number('1e3')`、`Number('')` 都会静默
  // 通过 isSafeInteger，粘贴场景下用户看到 `0x10` 却落盘 16。
  const isDigits = /^\d+$/.test(trimmed)
  const parsed = Number(trimmed)
  const isInRange = isDigits && parsed >= rule.min && parsed <= rule.max
  const isValid = isInRange && (!rule.integer || Number.isSafeInteger(parsed))
  /**
   * 只在用户改过之后才报非法。
   *
   * 设置文档里该键可能本来就缺省（`stallNoticeThreshold` 历史配置就没有默认值），
   * 此时草稿是空串：一进页面就飘着一条红色错误提示既没根据，也让人以为配置坏了。
   */
  const showInvalid = draft !== stored && !isValid
  const invalidText = describeViolation(trimmed, rule)

  function commit(): void {
    if (skipBlurRef.current) {
      skipBlurRef.current = false
      return
    }
    if (isValid) {
      props.onCommit(props.field.key, parsed)
      return
    }
    setDraft(stored)
  }

  // 有效时把「这个值被谁消费、多少才够得着」一起给人看：阈值填太大不会报错，
  // 只会静默地永不触发，那是配置页最该提醒却最容易漏的一类事实。
  // 用分号连接而不是句号：本页文案统一不用句号收尾（用户要求），但两句并排放
  // 只隔一个空格会读成病句。
  const hint = showInvalid ? invalidText : `${props.field.hint}；${rule.reachNote}`

  return jsx(SettingRow, {
    htmlFor: props.inputId,
    label: props.field.label,
    hint,
    hintId: props.hintId,
    hintTone: showInvalid ? 'invalid' : 'default',
    last: props.last,
    control: jsx(Input, {
      id: props.inputId,
      value: draft,
      disabled: props.disabled,
      inputMode: 'numeric',
      'aria-invalid': showInvalid,
      'aria-describedby': props.hintId,
      style: { width: NUMBER_INPUT_WIDTH, fontVariantNumeric: 'tabular-nums' },
      onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      onBlur: () => commit(),
      onKeyDown: (event: { key: string; currentTarget: { blur(): void } }) => {
        if (event.key === 'Enter') {
          commit()
          skipBlurRef.current = true
          event.currentTarget.blur()
          return
        }
        if (event.key === 'Escape') {
          // 还原到已保存值并退出编辑，这次 blur 不得提交任何东西。
          setDraft(stored)
          skipBlurRef.current = true
          event.currentTarget.blur()
        }
      },
    }),
  })
}

/**
 * 把违反的类型规则说清楚。
 *
 * README 的配置表把取值分成 boolean / 正整数 / 非负整数，界面提示必须落到同一套
 * 说法上，否则用户看到「请填不小于 1 的整数」而文档写「正整数」，会以为是两个规则。
 * @param text - 用户当前草稿（已 trim）
 * @param rule - 该字段的取值约束
 * @returns 一句中文提示
 */
function describeViolation(
  text: string,
  rule: { min: number; max: number; integer: boolean; reachNote: string },
): string {
  if (text === '') return `不能为空，请填写${describeKind(rule)}`
  if (!/^\d+$/.test(text)) return `只能填十进制数字，请填写${describeKind(rule)}`
  const value = Number(text)
  if (!Number.isSafeInteger(value) && rule.integer) return `超出可表示范围，请填写${describeKind(rule)}`
  if (value < rule.min) {
    return rule.min === 0 ? '不能小于 0（0 表示不续行）' : `必须大于等于 ${String(rule.min)}`
  }
  if (value > rule.max) return `必须小于等于 ${String(rule.max)}`
  return `请填写${describeKind(rule)}`
}

/**
 * 取值类型的自然语言说法，与 README 配置表一致。
 * @param rule - 该字段的取值约束
 * @returns 「正整数」或「非负整数」
 */
function describeKind(rule: { min: number; integer: boolean }): string {
  return rule.min >= 1 ? '正整数' : '非负整数'
}

/** 复制按钮：把常量放进剪贴板，并在按钮上给出一次性反馈。 */
function CopyButton(props: { readonly label: string; readonly text: string }): unknown {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<number | undefined>(undefined)

  // 卸载时清掉定时器：否则关闭设置面板后仍会对已卸载组件 setState。
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    },
    [],
  )

  function flash(next: 'copied' | 'failed'): void {
    setState(next)
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      setState('idle')
    }, COPY_FEEDBACK_MS)
  }

  return jsx(Button, {
    variant: 'outline',
    size: 'sm',
    type: 'button',
    onClick: () => {
      // 剪贴板可能被权限或非安全上下文拒绝；失败要显示出来，否则用户以为复制成功，
      // 粘贴出来却是上一次的内容。不抛给上层：这个分区不该因一次复制失败而崩。
      void navigator.clipboard.writeText(props.text).then(
        () => flash('copied'),
        () => flash('failed'),
      )
    },
    children: state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : props.label,
  })
}

/** 关闭初始注入后的补救说明：暖色提示块 + 可复制的 AGENTS.md 片段。 */
function GuidanceCallout(): unknown {
  return jsxs('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      marginTop: '12px',
      padding: '12px 14px',
      border: '0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-label) 24%, transparent)',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent)',
    },
    children: [
      jsx('strong', {
        style: { fontSize: '13px', fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-state-warn-label)' },
        children: '初始注入已关闭，请改用 AGENTS.md 承载规范',
      }),
      jsx('p', {
        style: { ...hintStyle, margin: 0 },
        children:
          '模型不会再自动收到声明规范，但 target_status 工具、收尾门与上游续行仍在工作。把下面这段写进用户级 AGENTS.md（~/.dsh/AGENTS.md）即可替代初始注入',
      }),
      jsx('pre', { style: codeStyle, children: __TM_AGENTS_SNIPPET__ }),
      jsxs('div', {
        style: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
        children: [
          jsx(CopyButton, { label: '复制规范正文', text: __TM_DECLARATION_TEXT__ }, 'declaration'),
          jsx(CopyButton, { label: '复制 AGENTS.md 片段', text: __TM_AGENTS_SNIPPET__ }, 'snippet'),
        ],
      }),
    ],
  })
}

/** 提示条：读取失败、写入冲突、只读部署共用同一种样式，错误用错误色。 */
function Notice(props: { readonly tone: 'error' | 'muted'; readonly children: unknown }): unknown {
  return jsx('p', {
    role: props.tone === 'error' ? 'alert' : undefined,
    style: {
      margin: '0 0 4px',
      fontSize: '12px',
      lineHeight: '18px',
      color:
        props.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
    },
    children: props.children,
  })
}

/** 设置分区主体。 */
function TargetMonitorSection(): unknown {
  const [view, setView] = useState<SettingsNamespaceView | undefined>(undefined)
  const [writable, setWritable] = useState(false)
  const [error, setError] = useState('')
  /**
   * 每字段的失败计数：只有失败的那个字段加一。
   * 用一个全局计数会让「A 写入失败」去冲掉用户在 B 里正打着的草稿——与本页
   * 「不丢用户输入」的立场相悖。
   */
  const [resetTokens, setResetTokens] = useState<Readonly<Record<string, number>>>({})

  /**
   * 最新视图的同步副本。
   * `write` 在 promise 链里执行，闭包里的 `view` 可能是几帧之前的；写入必须带
   * 最新 revision，否则自己连改两项就必然撞冲突。
   */
  const viewRef = useRef<SettingsNamespaceView | undefined>(undefined)
  /** 写入队列：串行化，避免同一份文档并发提交互相踩 revision。 */
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const settings = useMemo(() => remoteSettings(), [])

  useEffect(() => {
    void load()
  }, [])

  function applyView(next: SettingsNamespaceView | undefined): void {
    viewRef.current = next
    setView(next)
  }

  async function load(): Promise<void> {
    const result = await settings.describe()
    if (!result.ok) {
      setError(failureText(result.error))
      return
    }
    const found = findNamespace(result.value.namespaces)
    if (found === undefined) {
      setError('未找到本插件的配置条目；确认插件已在当前 profile 中启用')
      return
    }
    setWritable(result.value.writable)
    applyView(found)
    setError('')
  }

  /**
   * 写入一个字段。
   *
   * 冲突（另一个窗口先写过）时先重新读取拿到新 revision，再按用户这次的意图
   * 重试一次：设置页只有本插件一个写入方，用户可以接受「我这次点击覆盖了那项」，
   * 而弹回原值再让人重做一遍才是真的丢输入。重试仍失败才报错并回填草稿。
   */
  async function write(key: string, next: unknown): Promise<void> {
    let current = viewRef.current
    if (current === undefined) return

    let result = await settings.update(current.ns, { [key]: next }, current.revision)
    if (!result.ok && isConflict(result.error)) {
      await load()
      current = viewRef.current
      if (current === undefined) return
      result = await settings.update(current.ns, { [key]: next }, current.revision)
    }
    if (!result.ok) {
      setError(failureText(result.error))
      markFieldFailed(key)
      return
    }
    applyView(result.value)
    setError('')
  }

  /** 让指定字段的控件回到真实值（撤掉乐观开关与数字草稿），其它字段不受影响。 */
  function markFieldFailed(key: string): void {
    setResetTokens((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
  }

  function save(key: string, next: unknown): void {
    // 队列必须始终 resolvable：一次写入抛出（远程调用断线、冲突后重读失败）若让
    // queueRef 变成 rejected，后续 `.then` 就再也不会执行——之后每次点击都静默丢失。
    queueRef.current = queueRef.current.then(() => write(key, next)).catch((error: unknown) => {
      setError(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      markFieldFailed(key)
    })
  }

  const header = jsxs('header', {
    style: { display: 'flex', flexDirection: 'column', gap: HEADER_GAP },
    children: [
      jsx('h2', { style: headingStyle, children: 'DSH中断续行' }),
      jsx('p', {
        style: descriptionStyle,
        children:
          '轮次收尾前若模型没有声明目标状态，插件会注入一条续行提醒。除标注「需重启」的两项外，以下设置即时生效',
      }),
      jsx('p', {
        style: descriptionStyle,
        children:
          '两类提醒的次数规则不同：收尾时未声明，同一轮可反复注入、不设上限，达到阈值次数后向你发一次「可能卡住」提示；只有上游异常后的自动续行才受次数上限约束',
      }),
    ],
  })

  // 读不到命名空间时只剩说明与重试：没有条目就没有字段可渲染。
  if (view === undefined) {
    return jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '12px' },
      children: [
        header,
        error === ''
          ? jsx(Notice, { tone: 'muted', children: '正在读取配置…' })
          : jsxs('div', {
              style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' },
              children: [
                jsx(Notice, { tone: 'error', children: error }),
                jsx(Button, {
                  variant: 'outline',
                  size: 'sm',
                  type: 'button',
                  onClick: () => void load(),
                  children: '重试',
                }),
              ],
            }),
      ],
    })
  }

  const sectionOff = readField(view, 'declarationSection') === false
  // 保存期间不禁用控件：禁用会让正在聚焦的开关丢焦点，键盘用户每改一项都得从头 Tab。
  // 并发写入由 save() 的队列串行化，不需要靠 disabled 兜。
  const disabled = !writable

  const rows = FIELDS.map((field, index) => {
    const last = index === FIELDS.length - 1
    const hintId = `target-monitor-${field.key}-hint`
    const resetToken = resetTokens[field.key] ?? 0
    if (field.kind === 'boolean') {
      return jsx(
        ToggleRow,
        {
          field,
          value: readField(view, field.key),
          disabled,
          last,
          hintId,
          resetToken,
          onChange: (key: string, next: boolean) => save(key, next),
        },
        field.key,
      )
    }
    return jsx(
      NumberRow,
      {
        field,
        value: readField(view, field.key),
        disabled,
        last,
        inputId: `target-monitor-${field.key}`,
        hintId,
        resetToken,
        onCommit: (key: string, next: number) => save(key, next),
      },
      field.key,
    )
  })

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column' },
    children: [
      header,
      // 提示统一放在字段之前：设置项以后还会增加，放在末尾意味着「改了但看不到反馈」。
      error === '' ? null : jsx(Notice, { tone: 'error', children: error }),
      writable ? null : jsx(Notice, { tone: 'muted', children: '当前 profile 不接受写入' }),
      sectionOff ? jsx(GuidanceCallout, {}) : null,
      ...rows,
    ],
  })
}

/**
 * 取宿主注入的 remote 服务。
 * 用闭包变量接住：`apply` 时把 ctx 存下来，组件渲染时再读，避免把 ctx 塞进 props。
 */
let currentContext: ClientContext | undefined

function remoteSettings(): SettingsRemote {
  const context = currentContext
  if (context === undefined) throw new Error('target-monitor client: apply() 尚未运行')
  return context.remote.settings
}

/** 客户端插件入口；宿主在首次使用该插件时调用一次。 */
export function apply(context: ClientContext): void {
  currentContext = context
  context.slots.inject('settings.section', () =>
    context.slots.register(
      { name: 'settings.section', id: 'target-monitor', order: 60, label: () => 'DSH中断续行' },
      TargetMonitorSection,
    ),
  )
}
