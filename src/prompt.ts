/**
 * 面向模型的固定文案。
 *
 * 只允许常量与受校验的类别；绝不拼接文件内容、工具输出或用户输入，
 * 否则提醒本身就成了提示注入面（FR-016）。
 * @module
 */

/** 归一化后的提醒原因。 */
export type RepairReason = 'undeclared' | 'truncated'

/** 系统提示词章节：声明协议。静态注册一次，不逐轮注入。 */
export const DECLARATION_SECTION = [
  'Before you close a turn, declare the target state with target_status:',
  '- target_status("done") — the task is complete and you are about to report it.',
  '- target_status("awaiting_user") — you need a user decision or more information.',
  'If you close without declaring, the harness assumes the task is unfinished and asks you to continue.',
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
 * 面向用户的卡住提示。与模型提醒同批投递，但不要求模型做事。
 * @param threshold - 触发阈值
 */
export function stallNoticeText(threshold: number): string {
  return `[target-monitor] 本轮已连续 ${threshold} 次未声明目标状态，可能卡住；可随时中断或补充指示。`
}
