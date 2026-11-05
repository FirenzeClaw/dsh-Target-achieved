/**
 * 收尾判定的纯函数形式。
 *
 * 抽出它的理由：同一条判定要被两处使用——进程内的 `LocalMonitor` 与守护进程里的
 * 状态表。若各写一遍，两边的阈值比较、顺序、边界条件会慢慢分叉，而这种分叉
 * 表现为「换个入口行为就不一样」，极难归因。
 *
 * 本模块**不接触任何状态容器**：输入是一组标量，输出是一份计划，副作用由调用方
 * 负责落库。这样它既能被单测直接覆盖，也能在守护进程里以 `Map` 为存储复用。
 * @module
 */
import type { StopCause } from '../cause.ts'
import type { TargetMonitorConfig } from '../config.ts'
import type { GateReason } from '../trace.ts'

/** 判定所需的最小输入面。 */
export interface TurnStoppingPlanInput {
  /** 总开关；关闭时一切放行。 */
  enabled: boolean
  /** 是否顶层 agent；子 agent 不受门控。 */
  isRoot: boolean
  /** 归一化后的结束原因。 */
  cause: StopCause
  /** 本轮是否已声明（done / awaiting_user）。 */
  declared: boolean
  /** 本轮已注入次数（增量前）。 */
  repairs: number
  /** 本轮「可能卡住」提示是否已展示。 */
  noticeShown: boolean
  /** 跨轮累计的遗忘次数。 */
  forgetCount: number
  /** 当前配置快照。 */
  config: TargetMonitorConfig
}

/** 判定结果：要么放行并给出原因，要么注入并给出正文组合所需的事实。 */
export interface TurnStoppingPlan {
  /** 是否注入。 */
  inject: boolean
  /** 放行原因；`inject` 为真时为 `'undeclared'`。 */
  reason: GateReason
  /** 本轮第几次注入；放行时为 0。 */
  attempt: number
  /** 注入正文使用的结束原因。 */
  cause: StopCause
  /** 是否追加规范复述。 */
  reminder: boolean
  /** 是否追加「可能卡住」的用户提示。 */
  stallNotice: boolean
}

/**
 * 计算出本次收尾该怎么处理。
 *
 * 判定顺序与既有实现一致——先看「该不该管」，再看「管不管得了」，最后才是注入：
 * 1. 总开关关闭 → 放行 `disabled`；
 * 2. 非顶层 → 放行 `not-root`；
 * 3. 结束原因不适用（取消 / 错误）→ 放行 `aborted` / `error`；
 * 4. 本轮已声明 → 放行 `declared`；
 * 5. 否则注入，并给出是否追加复述与卡住提示。
 * @param input - 判定输入
 * @returns 判定计划（无副作用）
 */
export function planTurnStopping(input: TurnStoppingPlanInput): TurnStoppingPlan {
  const released = (reason: GateReason): TurnStoppingPlan => ({
    inject: false,
    reason,
    attempt: 0,
    cause: input.cause,
    reminder: false,
    stallNotice: false,
  })

  if (!input.enabled) return released('disabled')
  if (!input.isRoot) return released('not-root')
  if (input.cause === 'not-applicable') return released('error')
  if (input.declared) return released('declared')

  const attempt = input.repairs + 1
  return {
    inject: true,
    reason: 'undeclared',
    attempt,
    cause: input.cause,
    // 复述在注入时才消费阈值：若改成「达阈值即清零」，紧接着那次注入若因
    // 已声明而没发出，复述就永远丢了（spec 005 的 C-007）。
    reminder: input.forgetCount >= input.config.reminderThreshold,
    // 每轮最多一次卡住提示：次数到了但已经提示过，就不再重复。
    stallNotice: !input.noticeShown && attempt >= input.config.stallNoticeThreshold,
  }
}
