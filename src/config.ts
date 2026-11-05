/**
 * 配置解析与校验。
 *
 * 配置错误在启动时抛出，绝不静默回退到默认值——否则用户以为改了行为、实际按默认值跑，
 * 属于最难排查的一类故障。
 *
 * `enabled` 声明为 volatile：宿主设置页据此把它渲染成可编辑字段，并在改动后
 * 不重挂载插件地更新引用。因此插件必须在**每次使用时 `.get()`**，不能捕获快照，
 * 否则页面上的开关就是假的。
 *
 * 关键约束：宿主先用本模块导出的 {@link Config} 解析配置，再把**解析结果**传给
 * `apply`。此时 `enabled` 已经是 volatile 引用而不是布尔值，若在 `apply` 里重跑
 * schema，会抛 `$.enabled expected boolean but got [object Object]`，整条 entry
 * 变成 inactive——工具和提示词章节都不会出现。所以这里必须先认出"已解析"形态。
 * @module
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** 阈值默认值；schema 默认与手工校验共用同一处定义。 */
const DEFAULT_STALL_NOTICE_THRESHOLD = 5

export const Config = z.object({
  /** 总开关；关闭时收尾门不注入、工具直接拒绝声明。 */
  enabled: z.boolean().default(true).volatile(),
  /** 第几次未声明时向用户发出"可能卡住"提示。必须是正安全整数。 */
  stallNoticeThreshold: z.number().default(DEFAULT_STALL_NOTICE_THRESHOLD),
})

/** 宿主解析后的配置：volatile 字段是稳定引用，需 `.get()` 取当前值。 */
export interface ResolvedConfig {
  enabled: Volatile<boolean>
  stallNoticeThreshold: number
}

/** 门与工具读到的普通值。 */
export interface TargetMonitorConfig {
  enabled: boolean
  stallNoticeThreshold: number
}

/**
 * 判断宿主解析产物里的 volatile 引用。
 *
 * `Volatile<T>` 的公开契约只有 `get()`；不能用 `instanceof`，因为创建它的
 * cosmokit 可能与宿主不是同一份模块实例（本项目通过 link 接入，模块图不保证共用）。
 * @param value - 待判定的字段值
 * @returns 是否是 volatile 引用
 */
function isVolatileRef(value: unknown): value is Volatile<boolean> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * 校验阈值：未给出时取默认值，非法值抛出。
 *
 * 原始配置与已解析配置都要过这一关——`z.number()` 放行了 0、负数与小数，
 * 这里才是真正的边界。
 * @param value - 原始或已解析的阈值
 * @returns 合法的正安全整数
 * @throws 当取值不是正安全整数时
 */
function assertThreshold(value: unknown): number {
  if (value === undefined) return DEFAULT_STALL_NOTICE_THRESHOLD
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `target-monitor: config.stallNoticeThreshold 必须是正安全整数，收到 ${String(value)}`,
    )
  }
  return value
}

/**
 * 校验并归一化配置。
 *
 * 两种输入形态：
 * 1. 宿主已解析（`enabled` 是 volatile 引用）——原样沿用引用，只复核阈值；
 * 2. 单元测试或直接调用传入的原始对象（`enabled` 是布尔值或缺失）——走完整 schema。
 * @param raw - 宿主传入的配置，或原始配置对象
 * @returns 归一化后的配置（`enabled` 保持 volatile 引用）
 * @throws 当 `stallNoticeThreshold` 不是正安全整数时
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const input = (raw ?? {}) as Record<string, unknown>
  const enabled = input['enabled']

  if (isVolatileRef(enabled)) {
    // schemastery 会把 null 当成"走默认值"，而 null 不该被静默接受；assertThreshold 会拒绝它。
    return {
      enabled,
      stallNoticeThreshold: assertThreshold(input['stallNoticeThreshold']),
    }
  }

  assertThreshold(input['stallNoticeThreshold'])
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
  }
}
