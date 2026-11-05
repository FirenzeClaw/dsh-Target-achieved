/**
 * 上游异常后的轮次级恢复。
 *
 * 宿主的重试层（`dsh-llm-retry`）只管单次模型请求：重试耗尽后抛 `LlmError`，
 * 轮次以 `error` 结束，而 `agent/turn-stopping` 只挂在正常收尾路径上
 * （`dsh-agent-loop/lib/index.js:1001` 位于 try 内）。结果就是上游抖一下、
 * 任务停在半路，还得用户手动催一句。
 *
 * 本模块只做三件事：给错误分类、按 agent 记连续续行次数、判断该不该续。
 * 真正的投递在 `index.ts`——必须在轮次 idle 之后，否则消息会躺在队列里不生效
 * （`dsh-agent-loop/lib/index.js:854-860`）。
 * @module
 */

/**
 * 值得再给一轮的错误码。
 *
 * 与宿主 `DEFAULT_RETRYABLE_CODES`（`dsh-llm/lib/types/retry-policy.js:16-22`）逐项一致：
 * 宿主认为「重试可能有用」的那一类，才轮到我们判断「重试层放弃后还值不值得再给一轮」。
 * 不跟随 provider 自定义的 `retryableCodes`——那是「单次请求要不要重试」的问题，
 * 与本插件要回答的不是同一个问题。
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 按 agent 记录的连续续行状态；不持久化，进程重启归零是正确的。 */
export interface ResumeState {
  /** 已连续续行次数。 */
  consecutive: number
  /** 最近一次处理过的轮次号；用于「一轮至多续行一次」的幂等去重。 */
  lastTurn: number | undefined
}

/** 错误分类结果。 */
export type UpstreamErrorClass = 'retryable' | 'non-retryable'

/** 每个 agent 的续行状态。 */
const states = new WeakMap<Agent, ResumeState>()

/**
 * 判断一次错误是否值得再给一轮。
 *
 * 只看 `LlmError.code`，不解析 message：错误文本来自 provider，既不稳定，
 * 又会把「错误信息」变成「分类依据」——那是可被上游内容影响的判断。
 * @param error - `agent/error` 携带的原始 error
 * @returns 可续行或不可续行
 */
export function classifyUpstreamError(error: unknown): UpstreamErrorClass {
  if (!(error instanceof LlmError)) return 'non-retryable'
  return RETRYABLE_CODES.has(error.code) ? 'retryable' : 'non-retryable'
}

/**
 * 读取某 agent 的续行状态（只读快照，测试与调试用）。
 * @param agent - 目标 agent
 * @returns 状态副本；从未登记过时为 undefined
 */
export function resumeStateOf(agent: Agent): ResumeState | undefined {
  const state = states.get(agent)
  return state === undefined ? undefined : { ...state }
}

/**
 * 占用某一轮的续行机会。
 *
 * 与 {@link noteResume} 分开是刻意的：`agent/error` 可能在同一轮触发多次
 * （例如 `turn/end` 落盘失败会再抛一次），必须在**决定投递前**就去重，
 * 否则会排入两条 whenIdle 回调，投递两次。
 * @param agent - 目标 agent
 * @param turn - 当前轮次
 * @returns 本轮是否仍可续行（false 表示已占用或已处理）
 */
export function claimResumeTurn(agent: Agent, turn: number): boolean {
  const state = states.get(agent) ?? { consecutive: 0, lastTurn: undefined }
  if (state.lastTurn === turn) return false
  state.lastTurn = turn
  states.set(agent, state)
  return true
}

/**
 * 记一次成功投递。
 *
 * 只在确实调用了 `steer` 之后调用：计数语义是"续行过几次"，不是"判断过几次"，
 * 否则被上限挡住的那次也会被计入（contracts/resume-decision.md C-007）。
 * @param agent - 目标 agent
 */
export function noteResume(agent: Agent): void {
  const state = states.get(agent) ?? { consecutive: 0, lastTurn: undefined }
  state.consecutive += 1
  states.set(agent, state)
}

/**
 * 清零连续计数，保留轮次记录。
 *
 * 触发条件是一条正常 `finish` 帧——那证明上游通了。`error` / `aborted` 不清零，
 * 否则连续失败永远攒不起来。
 * @param agent - 目标 agent
 */
export function resetResume(agent: Agent): void {
  const state = states.get(agent)
  if (state === undefined) return
  state.consecutive = 0
}

/**
 * 丢弃某 agent 的全部续行状态。
 * @param agent - 目标 agent
 */
export function forgetResume(agent: Agent): void {
  states.delete(agent)
}
