/**
 * 浏览器端客户端插件：接管「设置 → 目标监测」分区。
 *
 * 为什么需要它：宿主只把 `.volatile()` 字段交给自动表单，且自动表单无法承载
 * 「关闭初始注入后给出 AGENTS.md 建议 + 复制按钮」这类交互。自定义分区可以把
 * 八个字段与建议放在同一页，并按 revision 做冲突检测。
 *
 * 构建约束（见 scripts/build-client.mjs）：本文件必须**自包含**，不得有相对 import
 * ——宿主模块表只解析裸模块名。React 与 react/jsx-runtime 由宿主提供。
 */

import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useState } from 'react'

/** 构建期注入：规范正文与 AGENTS.md 片段，来自宿主侧 src/prompt.ts，避免两处漂移。 */
declare const __TM_DECLARATION_TEXT__: string
declare const __TM_AGENTS_SNIPPET__: string

export const name = 'target-monitor-client'
export const inject = ['remote', 'slots']

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

type FieldKind = 'boolean' | 'number'

interface FieldSpec {
  readonly key: string
  readonly kind: FieldKind
  readonly label: string
  readonly hint: string
}

/**
 * 字段清单与顺序。
 * 默认值与语义以宿主侧 `src/config.ts` 为准；这里只负责呈现，不做校验之外的推断。
 */
const FIELDS: readonly FieldSpec[] = [
  {
    key: 'declarationSection',
    kind: 'boolean',
    label: 'Inject the declaration section at session start',
    hint: '关掉后不再注册系统提示词章节、不再注册 target_status 工具，收尾门与上游续行一并停用。',
  },
  {
    key: 'enabled',
    kind: 'boolean',
    label: 'Gate enabled',
    hint: '关闭后轮次收尾不做任何判定与注入。',
  },
  {
    key: 'stallNoticeThreshold',
    kind: 'number',
    label: 'Stall notice threshold',
    hint: '同一轮被注入多少次后，向用户发一次「可能卡住」提示。',
  },
  {
    key: 'reminderThreshold',
    kind: 'number',
    label: 'Reminder threshold',
    hint: '累计多少次「提醒后才补声明」之后，在下一次注入末尾复述规范。',
  },
  {
    key: 'reactionWindowMs',
    kind: 'number',
    label: 'Reaction window (ms)',
    hint: '注入后多久内完成声明算一次「遗忘」。',
  },
  {
    key: 'crossProcess',
    kind: 'boolean',
    label: 'Share state across processes',
    hint: '开启后计数与判定交给本机守护进程，多个 DSH 实例共享。守护进程不可用时自动退回进程内。',
  },
  {
    key: 'resumeOnUpstreamError',
    kind: 'boolean',
    label: 'Resume after upstream error',
    hint: '上游可重试错误耗尽后，自动续行一轮。',
  },
  {
    key: 'maxResumes',
    kind: 'number',
    label: 'Max resumes per turn',
    hint: '同一轮最多续行几次；0 表示不续行。',
  },
]

/** 从设置视图里认出本插件的命名空间：认特征字段，不依赖条目 id 的拼写。 */
function findNamespace(namespaces: readonly SettingsNamespaceView[]): SettingsNamespaceView | undefined {
  return namespaces.find((view) => {
    const value = view.value
    return typeof value === 'object' && value !== null && 'stallNoticeThreshold' in value
  })
}

function readField(view: SettingsNamespaceView, key: string): unknown {
  const value = view.value
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function failureText(failure: RemoteFailure): string {
  const code = failure.code ?? 'unknown'
  const message = failure.message ?? ''
  if (code === 'SETTINGS_CONFLICT') return '配置已被其他窗口修改，请刷新后重试。'
  return `${code}${message === '' ? '' : `: ${message}`}`
}

/** 复制按钮：把常量放进剪贴板，并在按钮上给出一次性反馈。 */
function CopyButton(props: { readonly label: string; readonly text: string }): unknown {
  const [copied, setCopied] = useState(false)
  return jsx('button', {
    type: 'button',
    style: { padding: '4px 10px', cursor: 'pointer' },
    onClick: () => {
      void navigator.clipboard.writeText(props.text).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
    },
    children: copied ? '已复制' : props.label,
  })
}

function FieldRow(props: {
  readonly field: FieldSpec
  readonly value: unknown
  readonly disabled: boolean
  readonly onChange: (key: string, next: unknown) => void
}): unknown {
  const { field, value, disabled, onChange } = props
  const control =
    field.kind === 'boolean'
      ? jsx('input', {
          type: 'checkbox',
          checked: value === true,
          disabled,
          onChange: (event: { target: { checked: boolean } }) => onChange(field.key, event.target.checked),
        })
      : jsx('input', {
          type: 'number',
          value: typeof value === 'number' ? String(value) : '',
          disabled,
          style: { width: '110px' },
          onChange: (event: { target: { value: string } }) => {
            const parsed = Number(event.target.value)
            if (Number.isFinite(parsed)) onChange(field.key, parsed)
          },
        })

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px 0' },
    children: [
      jsxs('label', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 500 },
        children: [control, field.label],
      }),
      jsx('span', { style: { opacity: 0.7, fontSize: '0.85em' }, children: field.hint }),
    ],
  })
}

/** 设置分区主体。 */
function TargetMonitorSection(): unknown {
  const [view, setView] = useState<SettingsNamespaceView | undefined>(undefined)
  const [writable, setWritable] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const settings = useMemo(() => remoteSettings(), [])

  useEffect(() => {
    void load()
  }, [])

  async function load(): Promise<void> {
    const result = await settings.describe()
    if (!result.ok) {
      setError(failureText(result.error))
      return
    }
    const found = findNamespace(result.value.namespaces)
    if (found === undefined) {
      setError('未找到本插件的配置条目；确认插件已在当前 profile 中启用。')
      return
    }
    setWritable(result.value.writable)
    setView(found)
    setError('')
  }

  async function save(key: string, next: unknown): Promise<void> {
    if (view === undefined) return
    setBusy(true)
    const result = await settings.update(view.ns, { [key]: next }, view.revision)
    setBusy(false)
    if (!result.ok) {
      setError(failureText(result.error))
      return
    }
    setView(result.value)
    setError('')
  }

  if (error !== '') {
    return jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '8px' },
      children: [
        jsx('p', { children: '目标监测（target-monitor）' }),
        jsx('p', { style: { color: '#c0392b' }, children: error }),
        jsx('button', { type: 'button', onClick: () => void load(), children: '重试' }),
      ],
    })
  }

  if (view === undefined) return jsx('p', { children: '正在读取配置…' })

  const sectionOff = readField(view, 'declarationSection') === false
  const disabled = !writable || busy

  const rows = FIELDS.map((field) =>
    jsx(
      FieldRow,
      {
        field,
        value: readField(view, field.key),
        disabled,
        onChange: (key: string, next: unknown) => void save(key, next),
      },
      field.key,
    ),
  )

  const guidance = sectionOff
    ? jsxs('div', {
        style: { borderLeft: '3px solid #d0a000', padding: '8px 12px', marginTop: '12px' },
        children: [
          jsx('strong', { children: '初始注入已关闭' }),
          jsx('p', {
            children:
              '模型不会再自动收到声明规范。若仍希望它在收尾前声明状态，把下面这段写进用户级 AGENTS.md（~/.dsh/AGENTS.md）：',
          }),
          jsx('pre', {
            style: { whiteSpace: 'pre-wrap', fontSize: '0.85em', background: 'rgba(0,0,0,0.05)', padding: '8px' },
            children: __TM_AGENTS_SNIPPET__,
          }),
          jsxs('div', {
            style: { display: 'flex', gap: '8px', marginTop: '8px' },
            children: [
              jsx(CopyButton, { label: '复制规范正文', text: __TM_DECLARATION_TEXT__ }),
              jsx(CopyButton, { label: '复制 AGENTS.md 片段', text: __TM_AGENTS_SNIPPET__ }),
            ],
          }),
        ],
      })
    : null

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column' },
    children: [
      jsx('h3', { style: { margin: '0 0 4px' }, children: '目标监测' }),
      jsx('p', {
        style: { opacity: 0.75, margin: '0 0 8px', fontSize: '0.9em' },
        children: '轮次收尾时若模型没有声明目标状态，插件会注入一条续行提醒。以下开关即时生效。',
      }),
      writable ? null : jsx('p', { style: { color: '#c0392b' }, children: '当前 profile 不接受写入。' }),
      ...rows,
      guidance,
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
      { name: 'settings.section', id: 'target-monitor', order: 60, label: () => '目标监测' },
      TargetMonitorSection,
    ),
  )
}
