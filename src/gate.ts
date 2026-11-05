/**
 * 收尾门：轮次即将关闭时判断是否放行。
 *
 * 判定只依赖显式声明（TurnLatch），**不解析助手文本**（FR-014）。
 * 注入必须排在队首（FR-017）：宿主的收尾钩子仅在 nextStep 为空时派发，
 * 正常路径下 steer 追加即为队首；若进入时队列非空（竞态），改用 prepend。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { classify, finishOf } from './cause.ts'
import type { TargetMonitorConfig } from './config.ts'
import { noticeSummary } from './notices.ts'
import { repairText, stallNoticeText } from './prompt.ts'
import { bumpRepair, isDeclared, latchOf, markNoticeShown } from './state.ts'

/** 门依赖的最小上下文面，便于单测替换宿主。 */
export interface GateDeps {
  readonly config: TargetMonitorConfig
  /** 该 agent 是否为顶层；只有顶层受门控。 */
  isRoot(agent: Agent): boolean
  /** 投递一条提醒；由宿主实现（steer / prepend）。 */
  deliver(agent: Agent, text: string, summary: string): void
}

/**
 * 处理一次收尾判断。
 * @param deps - 门依赖
 * @param agent - 即将关闭轮次的 agent
 * @param turn - 当前轮次号
 * @returns 是否拒绝了关闭（即是否注入了提醒）
 */
export function handleTurnStopping(deps: GateDeps, agent: Agent, turn: number): boolean {
  if (!deps.isRoot(agent)) return false

  const cause = classify(finishOf(agent, turn))
  // 取消/错误不该走到这里；真走到了也绝不复活。
  if (cause === 'not-applicable') return false

  if (isDeclared(agent, turn)) return false

  const attempt = bumpRepair(agent, turn)
  const repair = repairText(cause, attempt)

  // 阈值提示与修复提醒合并成一条消息：若分两条投递，第二条会被"队列非空则 prepend"
  // 的策略顶到队首，用户提示反而排在修复提示之前——顺序颠倒。
  const latch = latchOf(agent, turn)
  const needsStallNotice = !latch.noticeShown && attempt >= deps.config.stallNoticeThreshold
  if (needsStallNotice) markNoticeShown(agent, turn)

  const text = needsStallNotice
    ? `${repair}\n\n${stallNoticeText(deps.config.stallNoticeThreshold)}`
    : repair

  deps.deliver(agent, text, noticeSummary(turn, cause, attempt))
  return true
}
