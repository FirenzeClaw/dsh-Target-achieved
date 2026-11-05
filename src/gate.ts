/**
 * 收尾门：轮次即将关闭时判断是否放行。
 *
 * 判定只依赖显式声明（TurnLatch），**不解析助手文本**（FR-014）。
 * 注入必须排在队首（FR-017）：宿主的收尾钩子仅在 nextStep 为空时派发，
 * 正常路径下 steer 追加即为队首；若进入时队列非空（竞态），改用 prepend。
 *
 * 判定本身在 `monitor/plan.ts` 里以纯函数实现，本模块只负责把计划落成副作用
 * （改状态、投递、留痕），因此守护进程可以复用同一份判定。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { classify, finishOf } from './cause.ts'
import type { TargetMonitorConfig } from './config.ts'
import { forgetCountOf, noteInjection, resetForgetCount } from './forget.ts'
import { composeInjection } from './monitor/compose.ts'
import { planTurnStopping } from './monitor/plan.ts'
import { noticeSummary } from './notices.ts'
import { REMINDER_TEXT, repairText, stallNoticeText } from './prompt.ts'
import { bumpRepair, isDeclared, latchOf, markNoticeShown } from './state.ts'
import type { GateReason, TraceInput } from './trace.ts'

/** 门依赖的最小上下文面，便于单测替换宿主。 */
export interface GateDeps {
  /** 每次判定时读取当前配置；volatile 开关必须即时生效。 */
  config(): TargetMonitorConfig
  /** 该 agent 是否为顶层；只有顶层受门控。 */
  isRoot(agent: Agent): boolean
  /** 投递一条提醒；由宿主实现（steer / prepend）。 */
  deliver(agent: Agent, text: string, summary: string): void
  /** 当前时刻；测试可注入固定时钟。 */
  now?(): number
  /** 判定留痕；缺席时不留痕（纯单元测试）。 */
  trace?(agent: Agent, entry: TraceInput): void
}

/**
 * 处理一次收尾判断。
 * @param deps - 门依赖
 * @param agent - 即将关闭轮次的 agent
 * @param turn - 当前轮次号
 * @returns 是否拒绝了关闭（即是否注入了提醒）
 */
export function handleTurnStopping(deps: GateDeps, agent: Agent, turn: number): boolean {
  const released = (reason: GateReason): false => {
    // 放行也留痕：只有"查不到记录"才代表该轮未被判定。曾因放行无声，
    // 把"插件没运行"误判成"首轮不判定"（spec 004 / FR-001）。
    deps.trace?.(agent, { turn, outcome: 'released', reason, attempt: 0 })
    return false
  }

  const config = deps.config()
  const finish = finishOf(agent, turn)
  const cause = classify(finish)
  const latch = latchOf(agent, turn)

  const plan = planTurnStopping({
    enabled: config.enabled,
    isRoot: deps.isRoot(agent),
    cause,
    declared: isDeclared(agent, turn),
    repairs: latch.repairs,
    noticeShown: latch.noticeShown,
    forgetCount: forgetCountOf(agent),
    config,
  })

  if (!plan.inject) {
    // 取消与错误在留痕里要分开：这是事后区分「用户叫停」与「上游炸了」的唯一依据，
    // 而纯函数那一层把它们统一成了 not-applicable。
    const reason = plan.reason === 'error' && finish?.kind === 'aborted' ? 'aborted' : plan.reason
    return released(reason)
  }

  const now = deps.now?.() ?? Date.now()
  // 走到这里说明一定不是 not-applicable（那一支已被 plan 判成放行），
  // 这里显式收窄类型，避免把三态原因传进只接受两态的文案函数。
  const repairCause = plan.cause === 'truncated' ? 'truncated' : 'undeclared'
  // 先登记本次注入：下一次声明若落在反应窗口内，就会被计为一次"遗忘"。
  noteInjection(agent, now)

  bumpRepair(agent, turn)
  if (plan.stallNotice) markNoticeShown(agent, turn)
  // 复述只在真正发出注入的这一轮消费阈值，避免"达阈值但没发出去"导致复述丢失。
  if (plan.reminder) resetForgetCount(agent)

  // 正文组合与远程路径共用 composeInjection，保证两条路径逐字一致。
  const text = composeInjection(
    {
      inject: true,
      reason: plan.reason,
      attempt: plan.attempt,
      reminder: plan.reminder,
      stallNotice: plan.stallNotice,
      cause: plan.cause,
    },
    config.stallNoticeThreshold,
  )

  deps.deliver(agent, text, noticeSummary(turn, repairCause, plan.attempt))
  deps.trace?.(agent, { turn, outcome: 'injected', reason: 'undeclared', attempt: plan.attempt })
  return true
}
