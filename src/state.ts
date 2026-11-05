/**
 * 轮次目标状态（TurnLatch）。
 *
 * 状态只存内存，按「顶层 agent × 当前轮次」定位：轮次号变化即整体替换，
 * 因此"下一轮自动回到 working"是构造性成立的，不需要一段重置代码。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 目标状态。working 为缺省值，只能由模型工具改成另外两个。 */
export type TargetState = 'working' | 'done' | 'awaiting_user'

/** 一个轮次的全部可变状态。 */
export interface TurnLatch {
  /** 轮次号，与宿主事件里的 turn 对齐。 */
  readonly turn: number
  /** 当前声明；缺省 working。 */
  state: TargetState
  /** 本轮已发出的自救提醒次数。 */
  repairs: number
  /** "可能卡住"提示是否已展示，保证每轮最多一次。 */
  noticeShown: boolean
}

const latches = new WeakMap<Agent, TurnLatch>()

function fresh(turn: number): TurnLatch {
  return { turn, state: 'working', repairs: 0, noticeShown: false }
}

/**
 * 读取该 agent 在当前轮次的状态；轮次号变化时自动换新。
 * @param agent - 目标 agent
 * @param turn - 当前轮次号
 */
export function latchOf(agent: Agent, turn: number): TurnLatch {
  const existing = latches.get(agent)
  if (existing !== undefined && existing.turn === turn) return existing

  // 轮次变化即丢弃旧状态：done 不应跨轮存活。
  const next = fresh(turn)
  latches.set(agent, next)
  return next
}

/**
 * 记录一次声明；同一轮内后声明覆盖前声明。
 * @param agent - 目标 agent
 * @param turn - 当前轮次号
 * @param state - 目标状态
 */
export function declare(
  agent: Agent,
  turn: number,
  state: Exclude<TargetState, 'working'>,
): TurnLatch {
  const latch = latchOf(agent, turn)
  latch.state = state
  return latch
}

/**
 * 计一次自救提醒。
 * @returns 本轮累计次数
 */
export function bumpRepair(agent: Agent, turn: number): number {
  const latch = latchOf(agent, turn)
  latch.repairs += 1
  return latch.repairs
}

/** 标记"可能卡住"提示已展示。 */
export function markNoticeShown(agent: Agent, turn: number): void {
  latchOf(agent, turn).noticeShown = true
}

/** 清理该 agent 的全部状态（dispose 时调用）。 */
export function forget(agent: Agent): void {
  latches.delete(agent)
}

/** 该 agent 在本轮是否已声明（done 或 awaiting_user）。 */
export function isDeclared(agent: Agent, turn: number): boolean {
  const { state } = latchOf(agent, turn)
  return state === 'done' || state === 'awaiting_user'
}
