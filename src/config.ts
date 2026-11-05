/**
 * 配置解析与校验。
 *
 * 配置错误在启动时抛出，绝不静默回退到默认值——否则用户以为改了行为、实际按默认值跑，
 * 属于最难排查的一类故障。
 * @module
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** 总开关；关闭时不注册章节与工具，行为等价于未安装。 */
  enabled: z.boolean().default(true),
  /** 第几次未声明时向用户发出"可能卡住"提示。必须是正安全整数。 */
  stallNoticeThreshold: z.number().default(5),
})

export interface TargetMonitorConfig {
  enabled: boolean
  stallNoticeThreshold: number
}

/**
 * 校验并归一化配置。
 * @param raw - 宿主传入的原始配置
 * @returns 归一化后的配置
 * @throws 当 `stallNoticeThreshold` 不是正安全整数时
 */
export function resolveConfig(raw: unknown): TargetMonitorConfig {
  const input = (raw ?? {}) as Record<string, unknown>

  // 先校验原始输入：schemastery 会把 null 当成"走默认值"，而 null 不该被静默接受。
  const rawThreshold = input['stallNoticeThreshold']
  if (rawThreshold !== undefined
    && (typeof rawThreshold !== 'number' || !Number.isSafeInteger(rawThreshold) || rawThreshold < 1)) {
    throw new Error(
      `target-monitor: config.stallNoticeThreshold 必须是正安全整数，收到 ${String(rawThreshold)}`,
    )
  }

  return Config(input) as TargetMonitorConfig
}
