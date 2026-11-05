/**
 * 结束原因归一化。
 *
 * 宿主把结束原因结构化在 StreamChunk 的 finish 变体里，因此不需要解析文本（FR-014）。
 * 这里只区分"截断"与"其他"：其余原因要么到不了收尾钩子，要么文案相同。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FinishReason } from '@deepseek-ai/dsh-llm'

/** 归一化后的结束原因。 */
export type StopCause = 'truncated' | 'undeclared' | 'not-applicable'

interface Recorded {
  readonly turn: number
  readonly reason: FinishReason
}

const lastFinish = new WeakMap<Agent, Recorded>()

/**
 * 记录一次 finish；只保留本轮最后一次。
 * @param agent - 目标 agent
 * @param turn - 该 finish 所属轮次
 * @param reason - 宿主给出的结束原因
 */
export function recordFinish(agent: Agent, turn: number, reason: FinishReason): void {
  lastFinish.set(agent, { turn, reason })
}

/**
 * 读取该 agent 在指定轮次的结束原因；轮次不符视为未记录。
 * @param agent - 目标 agent
 * @param turn - 当前轮次
 */
export function finishOf(agent: Agent, turn: number): FinishReason | undefined {
  const recorded = lastFinish.get(agent)
  if (recorded === undefined || recorded.turn !== turn) return undefined
  return recorded.reason
}

/**
 * 归一化结束原因。
 * @param reason - 宿主的结束原因；缺省视为未声明
 */
export function classify(reason: FinishReason | undefined): StopCause {
  if (reason === undefined) return 'undeclared'
  if (reason.kind === 'max-tokens') return 'truncated'
  // aborted / error 走异常路径，不会派发收尾钩子；这里归为不适用，作纵深防御。
  if (reason.kind === 'aborted' || reason.kind === 'error') return 'not-applicable'
  return 'undeclared'
}

/** 清理该 agent 的记录。 */
export function forgetCause(agent: Agent): void {
  lastFinish.delete(agent)
}
