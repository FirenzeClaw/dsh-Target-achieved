/**
 * 远程实现：把判定交给守护进程，不可用时退回进程内。
 *
 * 降级是**单向**的（FR-012）：一个进程一旦降级就不再尝试远程。
 * 否则每次轮次收尾都要先等一次连接失败，而那个等待会直接落在用户的
 * 收尾延迟上——一个后台组件的问题不该变成对话的卡顿。
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TargetMonitorConfig } from '../config.ts'
import { connectClient, IpcError, ProtocolMismatchError, type DaemonClient } from '../ipc/client.ts'
import { ensureDaemon } from '../ipc/launcher.ts'
import type { DeclareData, MonitorConfigSnapshot, ResumeData, TurnStoppingData } from '../ipc/protocol.ts'
import { composeInjection } from './compose.ts'
import { noticeSummary } from '../notices.ts'
import { createLocalMonitor } from './local.ts'
import { snapshotOf, type Monitor, type TurnStoppingOutcome } from './types.ts'

/** 远程监视器的额外控制面。 */
export interface RemoteMonitor extends Monitor {
  /** 是否已降级。 */
  readonly degraded: boolean
  /** 主动关闭连接（进程退出时调用）。 */
  close(): void
}

/**
 * 创建远程实现；连接失败时**立即**返回一个已降级的实例。
 *
 * 这里不阻塞等待拉起：`apply` 是同步的，阻塞它会拖慢 DSH 启动。
 * 首次请求前才做一次 `ensureDaemon`，失败即降级。
 * @param options - socket 路径、配置读取器与告警回调
 * @returns 远程监视器
 */
export function createRemoteMonitor(options: {
  socketPath: string
  pidPath: string
  config(): TargetMonitorConfig
  warn(message: string): void
  now?(): number
}): RemoteMonitor {
  const local = createLocalMonitor(options.config, options.now ?? Date.now)
  const snapshot = (): MonitorConfigSnapshot => snapshotOf(options.config())

  let client: DaemonClient | undefined
  let degraded = false
  let connecting: Promise<DaemonClient> | undefined
  let warned = false

  /**
   * 退化到进程内实现，并且只告警一次（FR-018）。
   * @param reason - 原因，写入告警正文
   */
  const degrade = (reason: string): void => {
    if (degraded) return
    degraded = true
    client?.close()
    client = undefined
    if (!warned) {
      warned = true
      options.warn(`target-monitor: 跨进程守护不可用（${reason}），已退回进程内判定；计数不再跨进程共享`)
    }
  }

  /**
   * 取得可用连接；失败即降级。
   * @returns 连接，或 undefined（已降级）
   */
  const ensureClient = async (): Promise<DaemonClient | undefined> => {
    if (degraded) return undefined
    if (client !== undefined && !client.closed) return client
    if (connecting !== undefined) return connecting.catch(() => undefined)

    connecting = (async (): Promise<DaemonClient> => {
      const probe = await ensureDaemon({ socketPath: options.socketPath, pidPath: options.pidPath })
      if (probe !== 'ok') throw new IpcError('daemon did not become ready', 'E_CONNECT')
      return connectClient({ socketPath: options.socketPath })
    })()

    try {
      const connected = await connecting
      client = connected
      return connected
    } catch (error: unknown) {
      if (error instanceof ProtocolMismatchError) {
        // 版本不兼容时不重试：那会变成重启循环（契约 C-013）。
        degrade('协议版本不匹配')
      } else {
        degrade(error instanceof Error ? error.message : 'unknown')
      }
      return undefined
    } finally {
      connecting = undefined
    }
  }

  /**
   * 发一条请求；失败即降级并返回 undefined。
   * @param build - 由连接构造请求
   * @returns 结果，或 undefined（已降级）
   */
  const ask = async <T>(
    build: (request: (message: Parameters<DaemonClient['request']>[0]) => Promise<unknown>) => Promise<T> | undefined,
  ): Promise<T | undefined> => {
    const current = await ensureClient()
    if (current === undefined) return undefined
    try {
      return await build((message) => current.request(message))
    } catch (error: unknown) {
      degrade(error instanceof Error ? error.message : 'request failed')
      return undefined
    }
  }

  return {
    get degraded(): boolean {
      return degraded
    },

    config: snapshot,

    close(): void {
      client?.close()
      client = undefined
    },

    turnStart(agent: Agent, turn: number): void {
      // 远程需要显式告知轮次开始（守护进程没有 agent 对象可以"惰性换新"）；
      // 降级后本地实现不需要这个动作。
      if (degraded) return local.turnStart(agent, turn)
      void ask(async (request) => {
        await request({ type: 'turn-start', sessionId: agent.id as string, turn, config: snapshot() })
      })
    },

    async declare(agent: Agent, turn: number, state: 'done' | 'awaiting_user'): Promise<DeclareData> {
      const result = await ask(async (request) =>
        (await request({
          type: 'declare',
          sessionId: agent.id as string,
          turn,
          state,
          config: snapshot(),
        })) as DeclareData,
      )
      return result ?? local.declare(agent, turn, state)
    },

    async turnStopping(input): Promise<TurnStoppingOutcome> {
      const result = await ask(async (request) =>
        (await request({
          type: 'turn-stopping',
          sessionId: input.agent.id as string,
          turn: input.turn,
          finishKind: input.finishKind ?? 'stop',
          aborted: input.aborted,
          isRoot: input.isRoot,
          config: snapshot(),
        })) as TurnStoppingData,
      )
      if (result === undefined) return local.turnStopping(input)
      if (!result.inject) return { inject: false }

      // 正文在客户端组合：守护进程只回判定事实，不拼文案。
      // 这样文案改动不需要重启守护进程。
      const current = snapshot()
      return {
        inject: true,
        text: composeInjection(result, current.stallNoticeThreshold),
        summary: noticeSummary(input.turn, result.cause === 'truncated' ? 'truncated' : 'undeclared', result.attempt),
      }
    },

    async upstreamError(agent: Agent, turn: number, errorCode: string, retryable: boolean): Promise<ResumeData> {
      const result = await ask(async (request) =>
        (await request({
          type: 'upstream-error',
          sessionId: agent.id as string,
          turn,
          errorCode,
          retryable,
          config: snapshot(),
        })) as ResumeData,
      )
      return result ?? local.upstreamError(agent, turn, errorCode, retryable)
    },

    async resumeConfirm(agent: Agent, turn: number, errorCode: string): Promise<ResumeData> {
      const result = await ask(async (request) =>
        (await request({
          type: 'resume-confirm',
          sessionId: agent.id as string,
          turn,
          errorCode,
          config: snapshot(),
        })) as ResumeData,
      )
      return result ?? local.resumeConfirm(agent, turn, errorCode)
    },

    finish(agent: Agent, turn: number, kind: string): void {
      if (degraded) {
        local.finish(agent, turn, kind)
        return
      }
      // 通知是旁路：发不出去也不影响本地清零，直接两处都做。
      void ask(async (request) => {
        await request({ type: 'finish', sessionId: agent.id as string, turn, finishKind: kind as 'stop', config: snapshot() })
      })
      local.finish(agent, turn, kind)
    },

    dispose(agent: Agent): void {
      local.dispose(agent)
    },
  }
}
