/**
 * 轮次来源：插件内**唯一**的"现在是第几轮"。
 *
 * 为什么单独成模块：声明工具与收尾判定必须用同一个轮次号。此前轮次只在
 * `agent/turn-stopping` 里写入，而那是轮次**结束**时刻，导致一轮里的第一次
 * 声明落到上一轮的键上（首轮为哨兵 0），收尾判定读不到，仍然注入。
 *
 * 写入点有两个，且同源：
 * 1. `agent/assistant-stream` 的 `start` 帧——宿主在发起模型请求后、任何工具调用
 *    之前发出，带本轮 `turn`（`dsh-agent-loop` 的 `live.start()`）；
 * 2. `agent/turn-stopping`——兜底，覆盖不经过流式帧的路径。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

const currentTurn = new WeakMap<Agent, number>()

/**
 * 记录该 agent 当前轮次。
 * @param agent - 目标 agent
 * @param turn - 宿主给出的轮次号
 */
export function observeTurn(agent: Agent, turn: number): void {
  currentTurn.set(agent, turn)
}

/**
 * 读取该 agent 当前轮次。
 *
 * 返回 `undefined` 表示插件尚未观察到任何轮次——调用方必须显式处理，
 * **不得**用一个哨兵值代替：写进哨兵键的声明永远不会被收尾判定读到。
 * @param agent - 目标 agent
 * @returns 当前轮次号，或 undefined
 */
export function turnOf(agent: Agent): number | undefined {
  return currentTurn.get(agent)
}

/**
 * 清理该 agent 的轮次记录。
 * @param agent - 目标 agent
 */
export function forgetTurn(agent: Agent): void {
  currentTurn.delete(agent)
}
