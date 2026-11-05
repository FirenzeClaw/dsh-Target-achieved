/**
 * 插件入口：注册声明协议、目标状态工具与收尾门。
 *
 * 三件事各就各位：
 * 1. 系统提示词章节（静态、一次）告诉模型怎么声明；
 * 2. `target_status` 是声明通道；
 * 3. `agent/turn-stopping` 是判定与自救注入点。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { finishOf, forgetCause, recordFinish } from './cause.ts'
import { forgetForgetful, noteDeclaration } from './forget.ts'
import {
  claimResumeTurn,
  classifyUpstreamError,
  forgetResume,
  noteResume,
  resetResume,
  resumeStateOf,
  shouldResume,
} from './resume.ts'
import { Config, resolveConfig, snapshot, type ResolvedConfig, type TargetMonitorConfig } from './config.ts'
import { createNotice } from './notices.ts'
import { DECLARATION_SECTION, repairText } from './prompt.ts'
import { noticeSummary } from './notices.ts'
import { createLocalMonitor } from './monitor/local.ts'
import { createRemoteMonitor, type RemoteMonitor } from './monitor/remote.ts'
import type { Monitor } from './monitor/types.ts'
import { pidPath, socketPath } from './paths.ts'
import { forget } from './state.ts'
import { registerTargetStatus } from './tool.ts'
import { configureTrace, recordTrace } from './trace.ts'
import { forgetTurn, observeTurn, turnOf } from './turn.ts'

export { Config }
export type { TargetMonitorConfig }

export const name = 'target-monitor'

/** 依赖的宿主服务；缺失时 cordis 拒绝启动，等价于 fail loud（FR-015）。 */
export const inject = ['agents', 'tools', 'systemPrompt'] as const

/**
 * 章节排序：紧跟 goal 策略段（2400）、在 workflow 段（2600）之前。
 *
 * 不能沿用 900——那是宿主的 `FILE_REFERENCE` 序号，撞号后本节会被排进
 * AGENTS.md 正文中间（实测落在第 25 行，前后都是项目说明），一条必须被看见的
 * 协议就此被埋掉。2500 目前无占用。
 */
const SECTION_ORDER = 2500

/** 每个 agent 最近一次 assistant 流所属的轮次（由 start 帧给出）。 */
const streamTurn = new WeakMap<Agent, number>()

/**
 * 已 dispose 的 agent。
 *
 * 用 WeakSet 记录而不只依赖 `forgetResume`：`whenIdle()` 回调可能在 dispose 之后
 * 才兑现，那时状态早已被删干净，"查不到状态"与"从未续行过"无法区分。
 */
const disposed = new WeakSet<Agent>()

/** 是否至少收到过一次 finish 帧；用于判断 assistant-stream 契约是否可用。 */
let streamSeen = false

/** 降级提示只打印一次。 */
let warnedNoStream = false

/**
 * 取错误码用于留痕。
 *
 * 非 `LlmError` 一律记为 `UNKNOWN`：留着原始 message 会把 provider 文本写进
 * 留痕文件，既无助于分类，又多一处需要脱敏的地方。
 * @param error - 原始错误
 * @returns 稳定的错误码字符串
 */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN'
}

/**
 * 插件入口。
 * @param ctx - 插件上下文
 * @param rawConfig - 宿主传入的原始配置
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)

  // 留痕默认写到 $DSH_HOME/logs/target-monitor/；此处显式配置一次，
  // 让路径解析与上限在插件生命周期内固定（不逐条重算）。
  configureTrace({})

  // 选择判定通道。crossProcess 是启动期决策：运行中切换会让同一会话的状态
  // 在「守护进程」与「本进程」之间跳，计数随即失真；要换只能重启。
  const monitor: Monitor | RemoteMonitor =
    snapshot(config).crossProcess
      ? createRemoteMonitor({
          socketPath: socketPath(),
          pidPath: pidPath(),
          config: () => snapshot(config),
          warn: (message) => { console.warn(message) },
        })
      : createLocalMonitor(() => snapshot(config))

  // 不在这里 `if (!config.enabled) return`：enabled 是 volatile，用户随时可在设置页关掉，
  // 关掉后必须立刻停止注入。若启动时就 return，开关会变成"改了没反应"。
  ctx.systemPrompt.section({
    name: 'tool:target-monitor',
    order: SECTION_ORDER,
    text: DECLARATION_SECTION,
  })

  registerTargetStatus(
    ctx,
    turnOf,
    () => config.enabled.get() !== false,
    // 声明走判定通道：远程时由守护进程计数，本地时落到进程内状态。
    (agent, turn, state) => { void monitor.declare(agent, turn, state) },
  )

  /**
   * 投递一条自救提醒。
   *
   * FR-017：队首优先。空队列走 steer（会唤醒驱动）；非空则显式 prepend。
   * @param agent - 目标 agent
   * @param text - 正文
   * @param summary - 摘要
   */
  function deliver(agent: Agent, text: string, summary: string): void {
    const message = createNotice(text, summary)
    if (agent.inbox.nextStep.length === 0) agent.steer(message)
    else agent.inbox.prepend('next-step', message)
  }

  ctx.on('agent/turn-stopping', (payload) => {
    // 兜底写入：正常路径下 start 帧已经写过同一个值，这里覆盖成同值无害；
    // 不走流式帧的路径（极早期失败轮）靠这里补齐轮次。
    observeTurn(payload.agent, payload.turn)

    // 宿主在 abort/error 路径不会派发本钩子；这里再挡一次，取消绝不复活（FR-011）。
    if (payload.signal.aborted) return

    // 降级：若从未收到过任何 finish 帧，说明 assistant-stream 契约不可用，
    // 此时所有轮次都会按 undeclared 处理；只提示一次，避免刷屏。
    if (!streamSeen && !warnedNoStream) {
      warnedNoStream = true
      console.warn('target-monitor: 未收到 assistant-stream 的 finish 帧，停止原因分类降级为 undeclared')
    }

    const deliverOutcome = (outcome: { inject: boolean; text?: string; summary?: string }): void => {
      if (!outcome.inject || outcome.text === undefined) return
      deliver(payload.agent, outcome.text, outcome.summary ?? noticeSummary(payload.turn, 'undeclared', 1))
    }

    try {
      // 进程内实现同步返回，注入因此仍发生在监听器返回之前（宿主随后检查 nextStep）；
      // 跨进程实现返回 Promise，宿主以 serial 派发本钩子会等待它
      // （`dsh-agent-loop/lib/index.js:1001` 的 dispatch.serial）。
      const outcome = monitor.turnStopping({
        agent: payload.agent,
        turn: payload.turn,
        finishKind: finishOf(payload.agent, payload.turn)?.kind,
        aborted: false,
        isRoot: ctx.agents.roots().includes(payload.agent),
      })

      if (outcome instanceof Promise) return outcome.then(deliverOutcome).catch(reportGateError)
      deliverOutcome(outcome)
      return undefined
    } catch (error: unknown) {
      reportGateError(error)
      return undefined
    }

    /**
     * 门内异常不得打断对话；记录后放行本轮。
     * @param error - 异常
     */
    function reportGateError(error: unknown): void {
      console.warn('target-monitor: 收尾判断失败，本轮放行', error)
    }
  })

  /**
   * 上游异常后的轮次级恢复（spec 006）。
   *
   * 为什么不能在这里直接投递：`agent/error` 派发时轮次仍是 `running`，此时
   * `wakeDriver` 不置 `wakeRequested`（`dsh-agent-loop/lib/index.js:854-860`），
   * 消息只会躺在队列里——看起来注入成功，实际要等下次用户输入才被消费。
   * 所以只做判定与登记，真正投递推到 `whenIdle()` 之后。
   */
  ctx.on('agent/error', (payload) => {
    // 监听器内的异常绝不能外溢：它跑在宿主的错误传播路径上，
    // 再抛一次只会把真正的上游错误替换成插件自己的堆栈。
    try {
      scheduleResume({ agent: payload.agent, turn: payload.turn, error: payload.error })
    } catch (error: unknown) {
      console.warn('target-monitor: 续行判定失败，本轮按错误结束处理', error)
    }
  })

  /**
   * 判定并排队一次续行。
   * @param input - 事件负载中的 agent、轮次与错误
   */
  function scheduleResume(input: { agent: Agent; turn: number; error: unknown }): void {
    const { agent, turn, error } = input
    const errorCode = errorCodeOf(error)
    const retryable = classifyUpstreamError(error) === 'retryable'

    void monitor.upstreamError(agent, turn, errorCode, retryable).then((decision) => {
      if (!decision.resume) return

      return agent.whenIdle().then(async () => {
        // 等待期间用户可能已经取消、关闭开关或换了目标：投递前必须重新核对，
        // 否则一次迟到的投递就会绕过用户刚刚做出的决定。
        if (disposed.has(agent)) return
        if (!ctx.agents.roots().includes(agent)) return

        const confirmed = await monitor.resumeConfirm(agent, turn, errorCode)
        if (!confirmed.resume) return

        agent.steer(createNotice(repairText('undeclared', 1), noticeSummary(turn, 'upstream', 1)))
      })
    }).catch((error_: unknown) => {
      // whenIdle 或回调内的异常同样不能变成 unhandledRejection：
      // 那会在测试里静默失败，在生产里变成一条无人处理的告警。
      console.warn('target-monitor: 续行投递失败，本轮不续行', error_)
    })
  }

  ctx.on('agent/assistant-stream', (payload) => {
    const { frame } = payload
    // 轮次只在 start 帧上；chunk 帧没有 turn 字段。
    if (frame.type === 'start') {
      // 这是声明能拿到正确轮次的关键：宿主在发起模型请求后、任何工具调用之前发出本帧。
      // 若只依赖 turn-stopping（轮次结束）写入，一轮里的首次声明会落到上一轮的键上。
      observeTurn(payload.agent, frame.turn)
      streamTurn.set(payload.agent, frame.turn)
      return
    }
    if (frame.type !== 'chunk') return
    if (frame.chunk.type !== 'finish') return

    streamSeen = true
    const turn = streamTurn.get(payload.agent)
    if (turn === undefined) return
    recordFinish(payload.agent, turn, frame.chunk.reason)

    // 正常结束证明上游通了，连续失败计数清零；error / aborted 不清零，
    // 否则连续故障永远攒不到上限。
    const kind = frame.chunk.reason.kind
    if (kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens') resetResume(payload.agent)
  })

  ctx.on('agent/disposed', (payload) => {
    disposed.add(payload.agent)
    forget(payload.agent)
    forgetCause(payload.agent)
    forgetTurn(payload.agent)
    forgetForgetful(payload.agent)
    forgetResume(payload.agent)
  })
}
