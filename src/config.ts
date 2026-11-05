/**
 * 配置解析与校验。
 *
 * 配置错误在启动时抛出，绝不静默回退到默认值——否则用户以为改了行为、实际按默认值跑，
 * 属于最难排查的一类故障。
 *
 * volatile 字段（`enabled` / `reminderThreshold` / `reactionWindowMs` /
 * `resumeOnUpstreamError` / `maxResumes`）会被宿主设置页
 * 渲染成可编辑控件，并在改动后不重挂载插件地更新引用。因此插件必须在**每次使用时
 * `.get()`**，不能捕获快照，否则页面上的改动就是假的。
 *
 * 关键约束：宿主先用本模块导出的 {@link Config} 解析配置，再把**解析结果**传给
 * `apply`。此时 volatile 字段已经是引用而不是普通值，若在 `apply` 里重跑 schema，
 * 会抛 `$.enabled expected boolean but got [object Object]`，整条 entry 变成 inactive
 * ——工具和提示词章节都不会出现。所以这里必须先认出"已解析"形态。
 * @module
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** 第几次未声明时向用户发出"可能卡住"提示。 */
const DEFAULT_STALL_NOTICE_THRESHOLD = 5

/** 累计几次遗忘后复述一次声明规范。 */
const DEFAULT_REMINDER_THRESHOLD = 3

/** 注入后多久内的声明算作"被提醒才想起来"。实测响应中位数约 9.6 秒，留约 3 倍余量。 */
const DEFAULT_REACTION_WINDOW_MS = 30_000

/** 连续几次上游失败后不再自动续行。超过这个数，多半不是抖动而是真挂了。 */
const DEFAULT_MAX_RESUMES = 3

export const Config = z.object({
  /** 总开关；关闭时收尾门不注入、工具直接拒绝声明。 */
  enabled: z.boolean().default(true).volatile(),
  /** 第几次未声明时向用户发出"可能卡住"提示。必须是正安全整数。 */
  stallNoticeThreshold: z.number().default(DEFAULT_STALL_NOTICE_THRESHOLD),
  /** 累计几次遗忘后复述一次规范。必须是正安全整数。 */
  reminderThreshold: z.number().default(DEFAULT_REMINDER_THRESHOLD).volatile(),
  /** 注入后多久内的声明算作被提醒后才想起来的。必须是正安全整数。 */
  reactionWindowMs: z.number().default(DEFAULT_REACTION_WINDOW_MS).volatile(),
  /** 上游可重试错误后是否自动续行；关闭后只留痕不投递。 */
  resumeOnUpstreamError: z.boolean().default(true).volatile(),
  /** 连续续行上限；0 等价于关闭自动续行。 */
  maxResumes: z.number().default(DEFAULT_MAX_RESUMES).volatile(),
  /** 是否注入声明规范；关闭后工具与收尾门一并停用（spec 008）。 */
  declarationSection: z.boolean().default(true).volatile(),
  /** 是否使用跨进程守护；关闭后强制进程内判定（spec 007 / FR-016）。 */
  crossProcess: z.boolean().default(true).volatile(),
})

/** 宿主解析后的配置：volatile 字段是稳定引用，需 `.get()` 取当前值。 */
export interface ResolvedConfig {
  enabled: Volatile<boolean>
  stallNoticeThreshold: number
  reminderThreshold: Volatile<number>
  reactionWindowMs: Volatile<number>
  resumeOnUpstreamError: Volatile<boolean>
  maxResumes: Volatile<number>
  declarationSection: Volatile<boolean>
  crossProcess: Volatile<boolean>
}

/** 门与工具读到的普通值。 */
export interface TargetMonitorConfig {
  enabled: boolean
  stallNoticeThreshold: number
  reminderThreshold: number
  reactionWindowMs: number
  resumeOnUpstreamError: boolean
  maxResumes: number
  declarationSection: boolean
  crossProcess: boolean
}

/**
 * 判断宿主解析产物里的 volatile 引用。
 *
 * `Volatile<T>` 的公开契约只有 `get()`；不能用 `instanceof`，因为创建它的
 * cosmokit 可能与宿主不是同一份模块实例（本项目通过 link 接入，模块图不保证共用）。
 * @param value - 待判定的字段值
 * @returns 是否是 volatile 引用
 */
function isVolatileRef<T>(value: unknown): value is Volatile<T> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * 校验正安全整数阈值。
 *
 * `z.number()` 放行了 0、负数与小数，这里才是真正的边界。
 * @param value - 原始阈值
 * @param field - 字段名，用于错误信息
 * @param fallback - 缺省值
 * @returns 合法的正安全整数
 * @throws 当取值不是正安全整数时
 */
function assertPositiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`target-monitor: config.${field} 必须是正安全整数，收到 ${String(value)}`)
  }
  return value
}

/**
 * 校验非负安全整数（允许 0）。
 *
 * `maxResumes = 0` 是合法配置：语义是"关闭自动续行"，与"配置写错"必须区分开，
 * 所以不能复用 {@link assertPositiveInt}。
 * @param value - 原始取值
 * @param field - 字段名，用于错误信息
 * @param fallback - 缺省值
 * @returns 合法的非负安全整数
 * @throws 当取值不是非负安全整数时
 */
function assertNonNegativeInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`target-monitor: config.${field} 必须是非负安全整数，收到 ${String(value)}`)
  }
  return value
}

/**
 * 校验已解析形态下的 volatile 布尔字段。
 *
 * 已解析配置里 volatile 字段一定是引用；若拿到普通布尔，说明宿主契约变了，
 * 此时应当 fail loud 而不是把它当稳定值用——否则设置页的开关会失灵且没人察觉。
 * @param value - 疑似 volatile 引用
 * @param field - 字段名
 * @returns 原引用
 * @throws 当字段不是 volatile 引用或取值不是布尔时
 */
function assertVolatileBoolean(value: unknown, field: string): Volatile<boolean> {
  if (!isVolatileRef<boolean>(value)) {
    throw new Error(`target-monitor: config.${field} 在已解析配置中应为 volatile 引用，收到 ${String(value)}`)
  }
  if (typeof value.get() !== 'boolean') {
    throw new Error(`target-monitor: config.${field} 必须是布尔值，收到 ${String(value.get())}`)
  }
  return value
}

/**
 * 校验已解析形态下的 volatile 布尔字段，缺省时回落到默认值。
 *
 * 与 `assertVolatileBoolean` 的差别只在于「字段不存在」的处理：新增字段在
 * 旧配置对象上必然缺省，此时按默认值放行比抛错更合理——抛错会让一次插件
 * 升级直接把整条 entry 打成 inactive，而用户什么都没改。
 * @param value - 疑似 volatile 引用
 * @param field - 字段名，用于错误信息
 * @param fallback - 字段缺省时的取值
 * @returns volatile 引用（缺省时是一个只读常量引用）
 */
function assertVolatileBooleanOr(value: unknown, field: string, fallback: boolean): Volatile<boolean> {
  if (value === undefined) return Object.freeze({ get: () => fallback })
  return assertVolatileBoolean(value, field)
}

/**
 * 校验已解析形态下的 volatile 非负整数字段。
 * @param value - 疑似 volatile 引用
 * @param field - 字段名
 * @param fallback - 缺省值
 * @returns 原引用
 * @throws 当字段不是 volatile 引用或取值非法时
 */
function assertVolatileNonNegativeInt(value: unknown, field: string, fallback: number): Volatile<number> {
  if (!isVolatileRef<number>(value)) {
    throw new Error(`target-monitor: config.${field} 在已解析配置中应为 volatile 引用，收到 ${String(value)}`)
  }
  assertNonNegativeInt(value.get(), field, fallback)
  return value
}

/**
 * 校验已解析形态下的 volatile 数值字段。
 *
 * 先把引用解成当前值再校验：设置页写入非法值时应当立即报错，而不是等到某次判定
 * 读到它才行为异常。
 * @param value - 疑似 volatile 引用
 * @param field - 字段名
 * @param fallback - 缺省值
 * @returns 原引用（保持 volatile 语义）
 * @throws 当字段不是 volatile 引用或取值非法时
 */
function assertVolatilePositiveInt(value: unknown, field: string, fallback: number): Volatile<number> {
  if (!isVolatileRef<number>(value)) {
    throw new Error(`target-monitor: config.${field} 在已解析配置中应为 volatile 引用，收到 ${String(value)}`)
  }
  assertPositiveInt(value.get(), field, fallback)
  return value
}

/**
 * 校验并归一化配置。
 *
 * 两种输入形态：
 * 1. 宿主已解析（volatile 字段是引用）——原样沿用引用，只复核数值；
 * 2. 单元测试或直接调用传入的原始对象——走完整 schema。
 * @param raw - 宿主传入的配置，或原始配置对象
 * @returns 归一化后的配置（volatile 字段保持引用）
 * @throws 当任一侧阈值不是正安全整数时
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const input = (raw ?? {}) as Record<string, unknown>

  if (isVolatileRef<boolean>(input['enabled'])) {
    assertPositiveInt(input['stallNoticeThreshold'], 'stallNoticeThreshold', DEFAULT_STALL_NOTICE_THRESHOLD)
    return {
      enabled: input['enabled'],
      // 非 volatile 字段在已解析形态下就是普通数字，直接沿用。
      stallNoticeThreshold: input['stallNoticeThreshold'] as number,
      reminderThreshold: assertVolatilePositiveInt(
        input['reminderThreshold'],
        'reminderThreshold',
        DEFAULT_REMINDER_THRESHOLD,
      ),
      reactionWindowMs: assertVolatilePositiveInt(
        input['reactionWindowMs'],
        'reactionWindowMs',
        DEFAULT_REACTION_WINDOW_MS,
      ),
      resumeOnUpstreamError: assertVolatileBoolean(input['resumeOnUpstreamError'], 'resumeOnUpstreamError'),
      maxResumes: assertVolatileNonNegativeInt(input['maxResumes'], 'maxResumes', DEFAULT_MAX_RESUMES),
      declarationSection: assertVolatileBooleanOr(input['declarationSection'], 'declarationSection', true),
      crossProcess: assertVolatileBooleanOr(input['crossProcess'], 'crossProcess', true),
    }
  }

  // 原始路径要逐个复核：`z.number()` 放行 0、负数与小数，schema 不是边界。
  assertPositiveInt(input['stallNoticeThreshold'], 'stallNoticeThreshold', DEFAULT_STALL_NOTICE_THRESHOLD)
  assertPositiveInt(input['reminderThreshold'], 'reminderThreshold', DEFAULT_REMINDER_THRESHOLD)
  assertPositiveInt(input['reactionWindowMs'], 'reactionWindowMs', DEFAULT_REACTION_WINDOW_MS)
  assertNonNegativeInt(input['maxResumes'], 'maxResumes', DEFAULT_MAX_RESUMES)
  return Config(input) as ResolvedConfig
}

/**
 * 把 volatile 引用拍平成一次判定用的普通值。
 * @param config - 宿主解析后的配置
 */
export function snapshot(config: ResolvedConfig): TargetMonitorConfig {
  return {
    enabled: config.enabled.get() !== false,
    stallNoticeThreshold: config.stallNoticeThreshold,
    reminderThreshold: config.reminderThreshold.get(),
    reactionWindowMs: config.reactionWindowMs.get(),
    resumeOnUpstreamError: config.resumeOnUpstreamError.get() !== false,
    maxResumes: config.maxResumes.get(),
    declarationSection: config.declarationSection.get() !== false,
    crossProcess: config.crossProcess.get() !== false,
  }
}
