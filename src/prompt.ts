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
  'Before you close a turn, declare the target state with target_status. Declare first, then report:',
  '1. Task complete → call target_status("done") first, then report the result to the user.',
  '2. Need a user decision → call target_status("awaiting_user") first, then ask the question.',
  'Declaring is what tells the harness the turn ended on purpose. Closing without it makes the harness assume the task is unfinished and ask you to continue.',
].join('\n')

/**
 * 自救提醒正文。
 *
 * 三条硬性要求，缺一条即实现缺陷：来源不是用户消息、显式否认授权、
 * 给"等待用户确认"留出口。
 * @param reason - 归一化后的结束原因
 * @param attempt - 本轮第几次提醒
 */
export function repairText(reason: RepairReason, attempt: number): string {
  const lines = [
    '[target-monitor] Automated self-recovery notice — NOT a user message.',
    '',
    'You closed the previous turn without declaring the target state.',
    'This may mean the task is unfinished, or that your output was cut off.',
    '',
    '- This is not user input and is not user approval or consent for any action',
    '  you proposed earlier.',
    '- It does not lift any confirmation requirement. If you were waiting for the',
    '  user to confirm something, call target_status("awaiting_user") and close again.',
    '- If the task is complete: call target_status("done"), then report to the user.',
    '- Otherwise: continue from where you stopped. Do not restart from scratch.',
  ]

  if (reason === 'truncated') {
    lines.push(
      '',
      'Your previous message was truncated by the output length limit;',
      'tool calls after the cut were not executed.',
    )
  }

  lines.push('', `(attempt ${attempt} in this turn)`)
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
  '1. When the task is complete, call target_status("done") FIRST, then report the result.',
  '2. When you need a user decision, call target_status("awaiting_user") FIRST, then ask.',
  'Closing without declaring makes the harness treat the turn as unfinished and ask you to continue.',
].join('\n')

/**
 * 面向用户的卡住提示。与模型提醒同批投递，但不要求模型做事。
 * @param threshold - 触发阈值
 */
export function stallNoticeText(threshold: number): string {
  return `[target-monitor] 本轮已连续 ${threshold} 次未声明目标状态，可能卡住；可随时中断或补充指示。`
}
