/**
 * 注入正文的组合。
 *
 * 抽出来的理由和判定一样：本地与远程两条路径都必须产出逐字相同的消息。
 * 只要有一处偏移，用户就会看到「同一个插件的两种口气」，而这种差异
 * 不会被任何一侧的单元测试发现。
 * @module
 */
import { REMINDER_TEXT, repairText, stallNoticeText } from '../prompt.ts'
import type { TurnStoppingData } from '../ipc/protocol.ts'

/**
 * 组合一条自救注入的正文。
 *
 * 顺序：修复正文 → 规范复述（若到阈值）→ 卡住提示（若到阈值）。
 * 复述必须在正文之后：模型先读到「你忘了声明」，再读规范原文；
 * 卡住提示面向用户，放最后，避免它把复述挤到后面。
 * @param data - 判定结果
 * @param stallNoticeThreshold - 卡住提示的触发阈值
 * @returns 可直接投递的正文
 */
export function composeInjection(data: TurnStoppingData, stallNoticeThreshold: number): string {
  // 走到这里不会是 not-applicable（那一支已被判成放行），显式收窄以匹配文案函数。
  const cause = data.cause === 'truncated' ? 'truncated' : 'undeclared'
  const parts = [repairText(cause, data.attempt)]
  if (data.reminder) parts.push(REMINDER_TEXT)
  if (data.stallNotice) parts.push(stallNoticeText(stallNoticeThreshold))
  return parts.join('\n\n')
}
