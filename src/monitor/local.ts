/**
 * 进程内实现：把判定落在既有的 agent 级状态模块上。
 *
 * 这是降级路径，也是「守护进程不可用时的等价物」。它直接复用 `gate.ts` 的
 * 判定与投递组合，因此与引入守护进程之前的行为逐字一致——回归测试覆盖的
 * 就是这条路径。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TargetMonitorConfig } from '../config.ts'
import { handleTurnStopping } from '../gate.ts'
import type { DeclareData, ResumeData } from '../ipc/protocol.ts'
import { claimResumeTurn, noteResume, resetResume, resumeStateOf } from '../resume.ts'
import { declare as declareLatch } from '../state.ts'
import { noteDeclaration } from '../forget.ts'
import { recordTrace } from '../trace.ts'
import { snapshotOf, type Monitor, type TurnStoppingOutcome } from './types.ts'

/**
 * 创建进程内实现。
 * @param config - 读取当前配置的函数
 * @param now - 当前时刻；测试可注入
 * @returns 判定通道
 */
export function createLocalMonitor(config: () => TargetMonitorConfig, now: () => number = Date.now): Monitor {
  return {
    config: () => snapshotOf(config()),

    turnStart(_agent: Agent, _turn: number): void {
      // agent 级状态按轮次惰性换新（latchOf），无需显式重置。
    },

    declare(agent: Agent, turn: number, state: 'done' | 'awaiting_user'): Promise<DeclareData> {
      declareLatch(agent, turn, state)
      const current = config()
      const after = noteDeclaration(agent, now(), current.reactionWindowMs)
      // `noteDeclaration` 只在命中反应窗口时加一，用前后差值判断是否计入。
      return Promise.resolve({ forgetCount: after, counted: after > 0 })
    },

    turnStopping(input): TurnStoppingOutcome {
      let text = ''
      let summary = ''
      const injected = handleTurnStopping(
        {
          config,
          isRoot: () => input.isRoot,
          deliver(_agent: Agent, body: string, noticeSummaryText: string): void {
            text = body
            summary = noticeSummaryText
          },
          now,
          trace(agent: Agent, entry): void {
            recordTrace(agent, entry)
          },
        },
        input.agent,
        input.turn,
      )

      // 同步返回是本实现的硬要求：降级路径必须在监听器返回前完成注入，
      // 多一层 microtask 就可能让宿主在检查 nextStep 时还看不到消息。
      return injected ? { inject: true, text, summary } : { inject: false }
    },

    upstreamError(agent: Agent, turn: number, errorCode: string, retryable: boolean): Promise<ResumeData> {
      const current = config()
      if (!retryable) {
        recordTrace(agent, {
          turn,
          outcome: 'released',
          reason: 'upstream-skipped',
          attempt: 0,
          ...(errorCode === '' ? {} : { errorCode }),
        })
        return Promise.resolve({ resume: false, reason: 'non-retryable' })
      }
      // 只按总开关与续行开关判定：章节是否注入不影响续行（见 src/index.ts 的说明）。
      if (!current.enabled) return Promise.resolve({ resume: false, reason: 'disabled' })
      if (!current.resumeOnUpstreamError) return Promise.resolve({ resume: false, reason: 'disabled' })
      // 先占轮次再排队：同一轮可能触发多次 agent/error，不去重会投递两次。
      return Promise.resolve({ resume: claimResumeTurn(agent, turn), reason: 'ok' })
    },

    resumeConfirm(agent: Agent, turn: number, errorCode: string): Promise<ResumeData> {
      const current = config()
      const rejected = (reason: string): Promise<ResumeData> => {
        recordTrace(agent, {
          turn,
          outcome: 'released',
          reason: 'upstream-capped',
          attempt: 0,
          ...(errorCode === '' ? {} : { errorCode }),
        })
        return Promise.resolve({ resume: false, reason })
      }

      if (!current.enabled) return rejected('disabled')
      if (!current.resumeOnUpstreamError) return rejected('disabled')
      const consecutive = resumeStateOf(agent)?.consecutive ?? 0
      if (consecutive >= current.maxResumes) return rejected('capped')

      noteResume(agent)
      recordTrace(agent, {
        turn,
        outcome: 'injected',
        reason: 'upstream-resumed',
        attempt: 1,
        ...(errorCode === '' ? {} : { errorCode }),
      })
      return Promise.resolve({ resume: true, reason: 'ok' })
    },

    finish(agent: Agent, _turn: number, kind: string): void {
      // aborted / error 不清零，否则连续故障永远攒不到上限。
      if (kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens') resetResume(agent)
    },

    dispose(agent: Agent): void {
      // 具体清理在 index.ts 里统一做；这里保留钩子以便将来把状态内聚过来。
      resetResume(agent)
    },
  }
}
