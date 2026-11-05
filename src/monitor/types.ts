/**
 * 判定通道的抽象与两种实现的选择。
 *
 * 插件只依赖本接口；具体是走守护进程还是留在进程内，由 `createMonitor` 在启动时
 * 决定一次，运行期不再切换（FR-012）。
 *
 * 为什么保留两种实现而不是只留远程：守护进程是新增的故障面，起不来、被强杀、
 * 版本不匹配都会发生。只留远程等于把这些故障放大成「插件整体失效」，
 * 比它要解决的问题更糟（FR-017）。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TargetMonitorConfig } from '../config.ts'
import type { DeclareData, MonitorConfigSnapshot, ResumeData } from '../ipc/protocol.ts'

/** 收尾判定的结果：是否注入，以及要投递的正文。 */
export interface TurnStoppingOutcome {
  /** 是否注入。 */
  inject: boolean
  /** 要投递的正文；`inject` 为假时不存在。 */
  text?: string
  /** 消息摘要（进会话日志的来源标记）。 */
  summary?: string
}

/** 判定通道。 */
export interface Monitor {
  /** 轮次开始（可选实现；远程实现用它重置状态）。 */
  turnStart(agent: Agent, turn: number): void
  /** 声明目标状态。 */
  declare(agent: Agent, turn: number, state: 'done' | 'awaiting_user'): Promise<DeclareData>
  /** 收尾判定。 */
  turnStopping(input: {
    agent: Agent
    turn: number
    finishKind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' | undefined
    aborted: boolean
    isRoot: boolean
  }): TurnStoppingOutcome | Promise<TurnStoppingOutcome>
  /** 上游错误，判断是否排队续行。 */
  upstreamError(agent: Agent, turn: number, errorCode: string, retryable: boolean): Promise<ResumeData>
  /** idle 之后的二次判定。 */
  resumeConfirm(agent: Agent, turn: number, errorCode: string): Promise<ResumeData>
  /** 正常结束。 */
  finish(agent: Agent, turn: number, kind: string): void
  /** 会话结束。 */
  dispose(agent: Agent): void
  /** 当前配置快照（远程实现每次请求都带）。 */
  readonly config: () => MonitorConfigSnapshot
  /** 预热；远程实现用它把拉起等待挪到启动阶段。 */
  warmup?(): Promise<void>
}

/**
 * 把运行时配置转成协议快照。
 * @param config - 当前配置
 * @returns 协议快照
 */
export function snapshotOf(config: TargetMonitorConfig): MonitorConfigSnapshot {
  return {
    enabled: config.enabled,
    stallNoticeThreshold: config.stallNoticeThreshold,
    reminderThreshold: config.reminderThreshold,
    reactionWindowMs: config.reactionWindowMs,
    resumeOnUpstreamError: config.resumeOnUpstreamError,
    maxResumes: config.maxResumes,
    declarationSection: config.declarationSection,
  }
}
