/**
 * 遗忘计数：按 agent 跨轮累计"收尾前忘记声明、被注入提醒后才补上"的次数。
 *
 * 为什么需要它——实测 8 次注入全部在 8–19 秒内被响应，说明多数注入不是
 * "救活中断"，而是"提醒忘了先声明"。反复忘记说明系统提示词里的规范没有被
 * 持续遵守，需要周期性重申（spec 005）。
 *
 * 计数规则（契约 C-001…C-010）：
 * - 注入后在 `windowMs` 内声明成功 → 计一次；
 * - 真中断（窗口内始终没声明，下一次注入把它顶掉）→ **不清零也不计数**。
 *   若清零，长任务会把计数永远打回零，复述永不触发。
 *
 * 用"待判定时间戳"而不是定时器：窗口只是判断两个事件的间隔，不需要主动触发，
 * 因此没有需要清理的句柄，也没有 dispose 泄漏。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 每个 agent 的计数状态。 */
interface ForgetState {
  /** 已累计的遗忘次数。 */
  count: number
  /** 最近一次注入的时刻；`undefined` 表示没有待判定的注入。 */
  pendingAt: number | undefined
}

/** 状态以 agent 对象身份为键，随 agent 回收。 */
const states = new WeakMap<Agent, ForgetState>()

/**
 * 取（必要时创建）该 agent 的状态。
 * @param agent - 目标 agent
 */
function stateOf(agent: Agent): ForgetState {
  const existing = states.get(agent)
  if (existing !== undefined) return existing

  const created: ForgetState = { count: 0, pendingAt: undefined }
  states.set(agent, created)
  return created
}

/**
 * 记录一次注入。
 *
 * 若已存在未判定的注入，说明上一次注入始终没被响应（模型继续干活去了）——
 * 直接丢弃旧标记，不计数也不清零。
 * @param agent - 收到注入的 agent
 * @param now - 注入时刻（epoch ms）
 */
export function noteInjection(agent: Agent, now: number): void {
  stateOf(agent).pendingAt = now
}

/**
 * 记录一次成功声明。
 *
 * @param agent - 声明的 agent
 * @param now - 声明时刻（epoch ms）
 * @param windowMs - 反应窗口；超出即视为"不是被注入提醒后才想起来的"
 * @returns 累计计数（便于调用方与测试观察）
 */
export function noteDeclaration(agent: Agent, now: number, windowMs: number): number {
  const state = stateOf(agent)
  const pendingAt = state.pendingAt
  // 无论是否命中窗口都要消费掉标记：一次注入最多计一次。
  state.pendingAt = undefined
  if (pendingAt === undefined) return state.count

  if (now - pendingAt <= windowMs) state.count += 1
  return state.count
}

/**
 * 取出并清零"是否该发复述"的判定。
 *
 * 在**发出注入的时刻**调用，而不是累计到达阈值的时刻：若达阈值即清零，
 * 而紧接着那次注入恰好没发出（该轮已声明），复述就永远丢了。
 * @param agent - 目标 agent
 * @param threshold - 触发阈值；可在设置页调整，因此每次现读
 * @returns 本次注入是否应追加复述
 */
export function takeReminderDue(agent: Agent, threshold: number): boolean {
  const state = stateOf(agent)
  if (state.count < threshold) return false

  state.count = 0
  return true
}

/**
 * 读取当前累计的遗忘次数（不消费）。
 *
 * 判定改成「先读后决定、注入时才清」之后，需要在不改变状态的前提下取值——
 * `takeReminderDue` 会顺手清零，用它在判定前探测会把计数弄丢。
 * @param agent - 目标 agent
 * @returns 已累计的遗忘次数
 */
export function forgetCountOf(agent: Agent): number {
  return stateOf(agent).count
}

/**
 * 清零遗忘计数。
 *
 * 只在**确实发出**了带复述的注入之后调用（见 `src/gate.ts`）。
 * @param agent - 目标 agent
 */
export function resetForgetCount(agent: Agent): void {
  stateOf(agent).count = 0
}

/**
 * 清理该 agent 的计数；agent 结束时调用。
 * @param agent - 已结束的 agent
 */
export function forgetForgetful(agent: Agent): void {
  states.delete(agent)
}
