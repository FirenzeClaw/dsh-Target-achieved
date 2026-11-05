/**
 * 配置解析与校验。
 *
 * 配置错误在启动时抛出，绝不静默回退到默认值——否则用户以为改了行为、实际按默认值跑，
 * 属于最难排查的一类故障。
 *
 * `enabled` 声明为 volatile：宿主设置页据此把它渲染成可编辑字段，并在改动后
 * 不重挂载插件地更新引用。因此插件必须在**每次使用时 `.get()`**，不能捕获快照，
 * 否则页面上的开关就是假的。
 * @module
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

export const Config = z.object({
  /** 总开关；关闭时收尾门不注入、工具直接拒绝声明。 */
  enabled: z.boolean().default(true).volatile(),
  /** 第几次未声明时向用户发出"可能卡住"提示。必须是正安全整数。 */
  stallNoticeThreshold: z.number().default(5),
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
 * 校验并归一化配置。
 * @param raw - 宿主传入的原始配置
 * @returns 归一化后的配置（`enabled` 保持 volatile 引用）
 * @throws 当 `stallNoticeThreshold` 不是正安全整数时
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const input = (raw ?? {}) as Record<string, unknown>

  // 先校验原始输入：schemastery 会把 null 当成"走默认值"，而 null 不该被静默接受。
  const rawThreshold = input['stallNoticeThreshold']
  if (rawThreshold !== undefined
    && (typeof rawThreshold !== 'number' || !Number.isSafeInteger(rawThreshold) || rawThreshold < 1)) {
    throw new Error(
      `target-monitor: config.stallNoticeThreshold 必须是正安全整数，收到 ${String(rawThreshold)}`,
    )
  }

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
