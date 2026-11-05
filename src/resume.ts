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

/** 按 agent 记录的连续续行状态；不持久化，进程重启归零是正确的。 */
export interface ResumeState {
  /** 已连续续行次数。 */
  consecutive: number
  /** 最近一次处理过的轮次号；用于「一轮至多续行一次」的幂等去重。 */
  lastTurn: number | undefined
}
