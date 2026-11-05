/**
 * 守护进程的状态表：把「每个 agent 一份」的判定状态搬成「每个会话一份」。
 *
 * 存储从 `WeakMap<Agent, …>` 换成 `Map<sessionId, …>`，是因为 agent 对象无法
 * 跨进程识别；`sessionId` 才是同一会话在所有进程间的公共身份
 * （`dsh-agent/lib/types/types.d.ts:13` 的 `readonly id: SessionId`）。
 *
 * 语义与 `src/state.ts` + `src/forget.ts` + `src/resume.ts` 逐条对齐，
 * 差异只在存储与生命周期：这里由连接数与闲置时长驱动回收，而不是 GC。
 * @module
 */
import type { StopCause } from '../cause.ts'
import type { GateReason } from '../trace.ts'
import { planTurnStopping, type TurnStoppingPlan } from '../monitor/plan.ts'
import type { DeclareData, MonitorConfigSnapshot, ResumeData, TurnStoppingData } from '../ipc/protocol.ts'

/** 一轮的全部可变状态。 */
interface TurnState {
  turn: number
  /** 当前声明。 */
  state: 'working' | 'done' | 'awaiting_user'
  /** 本轮已注入次数。 */
  repairs: number
  /** 「可能卡住」提示是否已展示。 */
  noticeShown: boolean
}

/** 一个会话的全部状态；跨轮存活的部分与轮次无关。 */
export interface SessionState {
  turn: TurnState
  /** 累计遗忘次数（跨轮）。 */
  forgetCount: number
  /** 上次注入时刻，用于判断声明是否落在反应窗口内。 */
  pendingAt: number | undefined
  /** 连续上游失败续行次数（跨轮）。 */
  resumeConsecutive: number
  /** 最近一次已处理续行的轮次（去重）。 */
  lastResumeTurn: number | undefined
  /** 最近一次访问时刻，用于闲置回收。 */
  touchedAt: number
}

/** 闲置多久后回收会话状态；24 小时足够覆盖"用户明天再来"。 */
export const IDLE_TTL_MS = 24 * 60 * 60 * 1000

/** 状态表。 */
const states = new Map<string, SessionState>()

/**
 * 取（必要时创建）会话状态。
 * @param sessionId - 会话标识
 * @param turn - 当前轮次
 * @param now - 当前时刻
 * @returns 会话状态
 */
export function stateOf(sessionId: string, turn: number, now: number): SessionState {
  const existing = states.get(sessionId)
  if (existing !== undefined) {
    existing.touchedAt = now
    rollTurn(existing, turn)
    return existing
  }

  const created: SessionState = {
    turn: { turn, state: 'working', repairs: 0, noticeShown: false },
    forgetCount: 0,
    pendingAt: undefined,
    resumeConsecutive: 0,
    lastResumeTurn: undefined,
    touchedAt: now,
  }
  states.set(sessionId, created)
  return created
}

/**
 * 轮次变化时重置轮内状态，保留跨轮计数。
 *
 * 与 `src/state.ts` 的构造性重置等价：`done` 不应跨轮存活，而遗忘计数与续行
 * 计数必须跨轮累计，否则阈值永远到不了。
 * @param state - 会话状态
 * @param turn - 新的轮次号
 */
function rollTurn(state: SessionState, turn: number): void {
  if (state.turn.turn === turn) return
  state.turn = { turn, state: 'working', repairs: 0, noticeShown: false }
}

/**
 * 处理轮次开始。
 * @param sessionId - 会话标识
 * @param turn - 轮次号
 * @param now - 当前时刻
 */
export function turnStart(sessionId: string, turn: number, now: number): void {
  stateOf(sessionId, turn, now)
}

/**
 * 处理一次声明，并在反应窗口内累计遗忘次数。
 * @param sessionId - 会话标识
 * @param turn - 轮次号
 * @param declared - 声明值
 * @param now - 当前时刻
 * @param windowMs - 反应窗口
 * @returns 计数与本次是否计入
 */
export function declare(
  sessionId: string,
  turn: number,
  declared: 'done' | 'awaiting_user',
  now: number,
  windowMs: number,
): DeclareData {
  const state = stateOf(sessionId, turn, now)
  state.turn.state = declared

  const pendingAt = state.pendingAt
  // 无论是否命中窗口都要消费掉标记：一次注入最多计一次（与 forget.ts 一致）。
  state.pendingAt = undefined
  if (pendingAt === undefined) return { forgetCount: state.forgetCount, counted: false }

  const counted = now - pendingAt <= windowMs
  if (counted) state.forgetCount += 1
  return { forgetCount: state.forgetCount, counted }
}

/**
 * 收尾判定。
 * @param input - 会话、轮次、结束原因、是否顶层、配置与当前时刻
 * @returns 判定数据
 */
export function turnStopping(input: {
  sessionId: string
  turn: number
  cause: StopCause
  aborted: boolean
  isRoot: boolean
  config: MonitorConfigSnapshot
  now: number
}): TurnStoppingData {
  const state = stateOf(input.sessionId, input.turn, input.now)
  const plan = planTurnStopping({
    enabled: input.config.enabled && input.config.declarationSection,
    isRoot: input.isRoot,
    cause: input.cause,
    declared: state.turn.state === 'done' || state.turn.state === 'awaiting_user',
    repairs: state.turn.repairs,
    noticeShown: state.turn.noticeShown,
    forgetCount: state.forgetCount,
    config: {
      enabled: input.config.enabled,
      stallNoticeThreshold: input.config.stallNoticeThreshold,
      reminderThreshold: input.config.reminderThreshold,
      reactionWindowMs: input.config.reactionWindowMs,
      resumeOnUpstreamError: input.config.resumeOnUpstreamError,
      maxResumes: input.config.maxResumes,
      declarationSection: input.config.declarationSection,
    },
  })

  if (!plan.inject) {
    // 取消与错误要分开留痕：这是事后区分「用户叫停」与「上游炸了」的唯一依据。
    const reason: GateReason = plan.reason === 'error' && input.aborted ? 'aborted' : plan.reason
    return { inject: false, reason, attempt: 0, reminder: false, stallNotice: false, cause: input.cause }
  }

  applyPlan(state, plan, input.now)
  return {
    inject: true,
    reason: 'undeclared',
    attempt: plan.attempt,
    reminder: plan.reminder,
    stallNotice: plan.stallNotice,
    cause: plan.cause,
  }
}

/**
 * 把判定计划落成状态变更。
 * @param state - 会话状态
 * @param plan - 判定计划
 * @param now - 当前时刻
 */
function applyPlan(state: SessionState, plan: TurnStoppingPlan, now: number): void {
  state.pendingAt = now
  state.turn.repairs = plan.attempt
  if (plan.stallNotice) state.turn.noticeShown = true
  if (plan.reminder) state.forgetCount = 0
}

/**
 * 记录一次上游错误，判断是否可以排队续行。
 * @param input - 会话、轮次、配置与当前时刻
 * @returns 是否排队
 */
export function upstreamError(input: {
  sessionId: string
  turn: number
  config: MonitorConfigSnapshot
  now: number
}): ResumeData {
  const state = stateOf(input.sessionId, input.turn, input.now)
  if (!input.config.enabled || !input.config.declarationSection) return { resume: false, reason: 'disabled' }
  if (!input.config.resumeOnUpstreamError) return { resume: false, reason: 'disabled' }
  if (input.config.maxResumes === 0) return { resume: false, reason: 'capped' }
  // 同一轮只排一次：同一轮可能触发多次 agent/error（例如落盘失败）。
  if (state.lastResumeTurn === input.turn) return { resume: false, reason: 'same-turn' }
  state.lastResumeTurn = input.turn
  return { resume: true, reason: 'ok' }
}

/**
 * idle 之后的二次判定。
 * @param input - 会话、轮次、配置与当前时刻
 * @returns 是否可以投递
 */
export function resumeConfirm(input: {
  sessionId: string
  turn: number
  config: MonitorConfigSnapshot
  now: number
}): ResumeData {
  const state = stateOf(input.sessionId, input.turn, input.now)
  if (!input.config.enabled || !input.config.declarationSection) return { resume: false, reason: 'disabled' }
  if (!input.config.resumeOnUpstreamError) return { resume: false, reason: 'disabled' }
  if (state.resumeConsecutive >= input.config.maxResumes) return { resume: false, reason: 'capped' }

  state.resumeConsecutive += 1
  return { resume: true, reason: 'ok' }
}

/**
 * 记录一次正常结束：连续失败计数清零。
 * @param sessionId - 会话标识
 * @param turn - 轮次号
 * @param kind - 结束原因
 * @param now - 当前时刻
 */
export function finish(sessionId: string, turn: number, kind: string, now: number): void {
  const state = stateOf(sessionId, turn, now)
  // aborted / error 不清零，否则连续故障永远攒不到上限（与 resume.ts 一致）。
  if (kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens') state.resumeConsecutive = 0
}

/** 删除会话语义状态；dispose 时调用。 */
export function forgetSession(sessionId: string): void {
  states.delete(sessionId)
}

/** 回收闲置过久的会话，防止长跑进程的内存只增不减。 */
export function sweep(now: number, ttlMs: number = IDLE_TTL_MS): number {
  let removed = 0
  for (const [sessionId, state] of states) {
    if (now - state.touchedAt > ttlMs) {
      states.delete(sessionId)
      removed += 1
    }
  }
  return removed
}

/** 清空全部状态；仅供测试使用。 */
export function resetSessions(): void {
  states.clear()
}

/** 当前状态表大小；供测试与诊断使用。 */
export function sessionCount(): number {
  return states.size
}
