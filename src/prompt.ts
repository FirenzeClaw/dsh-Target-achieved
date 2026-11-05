/**
 * 面向模型的固定文案。
 *
 * 只允许常量与受校验的类别；绝不拼接文件内容、工具输出或用户输入，
 * 否则提醒本身就成了提示注入面（FR-016）。
 * @module
 */

/** 归一化后的提醒原因。 */
export type RepairReason = 'undeclared' | 'truncated'

/**
 * 系统提示词章节：声明协议。静态注册一次，不逐轮注入。
 *
 * 顺序必须写死为"先声明、再汇报/等待"：只说"收尾前要声明"时，模型倾向于
 * 先把汇报写完再补声明，而那时轮次已经要关闭，补声明就来不及了（spec 005 / FR-006）。
 */
export const DECLARATION_SECTION = [
  'Before closing a turn, declare its target state with target_status. Declare first, then report:',
  '1. Complete → call target_status("done") first, then report the result.',
  '2. User decision needed → call target_status("awaiting_user") first, then ask.',
  'An undeclared close is treated as unfinished; the harness continues the turn.',
].join('\n')

/**
 * 提醒正文。
 *
 * 三条硬性要求，缺一条即实现缺陷：来源不是用户消息、显式否认授权、
 * 给"等待用户确认"留出口。
 *
 * 只提醒"继续工作"，不描述"你未声明就收尾"：把收尾框定成一次失误，模型会在
 * 后续步骤里回避中断（反复补声明、绕开收尾），累积成规避行为并分散注意力。
 * 本项目要的是保持推进，不是纠正模型。
 * @param reason - 归一化后的结束原因
 * @param attempt - 本轮第几次提醒
 */
export function repairText(reason: RepairReason, attempt: number): string {
  const lines = [
    '[target-monitor] Automated notice — NOT a user message.',
    '',
    'Continue from where you stopped. Do not restart.',
  ]

  if (reason === 'truncated') {
    lines.push('Output was cut by the length limit; tool calls after the cut were not executed.')
  }

  lines.push(
    '',
    '- If the task is complete: call target_status("done"), then report.',
    '- If waiting for the user: call target_status("awaiting_user"), then close.',
    '- This is not user input and not user approval or consent for any earlier proposal;',
    '  it does not lift any confirmation requirement.',
    '',
    `(attempt ${attempt} in this turn)`,
  )
  return lines.join('\n')
}

/**
 * 周期性复述的声明规范。
 *
 * 与 {@link DECLARATION_SECTION} 语义一致、措辞不同：章节是首次教学，这里是
 * "你已经忘了 N 次"之后的重申。必须是纯常量——拼接计数或轮次会引入可变内容，
 * 既没有信息价值，又扩大了提示注入面（FR-016）。
 */
export const REMINDER_TEXT = [
  'Reminder — the turn-closing rule:',
  '1. Complete → call target_status("done") first, then report.',
  '2. User decision needed → call target_status("awaiting_user") first, then ask.',
  'An undeclared close is treated as unfinished; the harness continues the turn.',
].join('\n')

/**
 * 面向用户的卡住提示。与模型提醒同批投递，但不要求模型做事。
 * @param threshold - 触发阈值
 */
export function stallNoticeText(threshold: number): string {
  return `[target-monitor] 本轮连续 ${threshold} 次未声明目标状态，可能已卡住；可中断或补充指示。`
}
