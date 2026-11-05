/**
 * 自救提醒的消息构造与来源归属。
 *
 * 关键约束：来源必须是可归属到本插件的独立 kind，**绝不能是 'user'**。
 * 宿主用 `source.kind === 'user'` 判定"人类直接请求"（例如 goal 工具的授权检查），
 * 用 'user' 投递提醒等于伪造人类授权。
 * @module
 */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** 本插件投递的消息来源。 */
export interface TargetMonitorSource {
  readonly kind: 'target-monitor'
  readonly form: 'notice'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'target-monitor': TargetMonitorSource
  }
}

/**
 * 构造一条归属本插件的提醒消息。
 * @param text - 固定文案
 * @param summary - 一行摘要，用于会话日志与审计
 */
export function createNotice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'target-monitor', form: 'notice', summary },
  })
}

/** 生成一行审计摘要。 */
export function noticeSummary(turn: number, reason: string, attempt: number): string {
  return `turn ${turn} · ${reason} · #${attempt}`
}
