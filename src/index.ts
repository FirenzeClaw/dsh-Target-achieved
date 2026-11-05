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
import { forgetCause, recordFinish } from './cause.ts'
import { forgetForgetful, noteDeclaration } from './forget.ts'
import { Config, resolveConfig, snapshot, type TargetMonitorConfig } from './config.ts'
import { createNotice } from './notices.ts'
import { DECLARATION_SECTION } from './prompt.ts'
import { handleTurnStopping, type GateDeps } from './gate.ts'
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

/** 是否至少收到过一次 finish 帧；用于判断 assistant-stream 契约是否可用。 */
let streamSeen = false

/** 降级提示只打印一次。 */
let warnedNoStream = false

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
    // 声明时刻与反应窗口现读：窗口可在设置页调整，捕获快照会让改动失效。
    (agent) => noteDeclaration(agent, Date.now(), config.reactionWindowMs.get()),
  )

  const gate: GateDeps = {
    // config 作为访问器传入：每次判定都读当前值，而不是 apply 时的快照。
    config: () => snapshot(config),
    isRoot: (agent) => ctx.agents.roots().includes(agent),
    deliver(agent, text, summary) {
      const message = createNotice(text, summary)
      // FR-017：队首优先。空队列走 steer（会唤醒驱动）；非空则显式 prepend。
      if (agent.inbox.nextStep.length === 0) agent.steer(message)
      else agent.inbox.prepend('next-step', message)
    },
    trace(agent, entry) {
      // 留痕是旁路：recordTrace 内部吞掉 I/O 异常，绝不会让门失败（FR-007）。
      recordTrace(agent, entry)
    },
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

    try {
      // 必须同步注入：监听器返回后宿主立刻检查 nextStep，晚了就关轮。
      handleTurnStopping(gate, payload.agent, payload.turn)
    } catch (error: unknown) {
      // 门内异常不得打断对话；记录后放行本轮。
      console.warn('target-monitor: 收尾判断失败，本轮放行', error)
    }
  })

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
  })

  ctx.on('agent/disposed', (payload) => {
    forget(payload.agent)
    forgetCause(payload.agent)
    forgetTurn(payload.agent)
    forgetForgetful(payload.agent)
  })
}
