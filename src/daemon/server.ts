/**
 * 守护进程的请求分发。
 *
 * 三件事：把请求映射到状态表、写留痕、把异常挡在进程内。
 * 幂等缓存也在这里——客户端超时重发时并不知道上一次是否已经生效，
 * 若不去重，一次网络抖动就会被记成两次遗忘（契约 C-007）。
 * @module
 */
import type { StopCause } from '../cause.ts'
import { IDEMPOTENCY_CAPACITY, type RequestMessage, type TurnStoppingData } from '../ipc/protocol.ts'
import type { TraceInput } from '../trace.ts'
import { declare, finish, forgetSession, resumeConfirm, turnStart, turnStopping, upstreamError } from './state.ts'

/** 分发所需的副作用面，便于测试注入固定时钟与留痕收集器。 */
export interface ServerDeps {
  /** 当前时刻。 */
  now(): number
  /** 写一条留痕。 */
  trace(rawSessionId: string, input: TraceInput): void
}

/** 分发结果。 */
export type HandleResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string }

/**
 * 幂等缓存：键为 `sessionId:turn:type`，值为首次成功的结果。
 *
 * 只缓存**有副作用且重复无意义**的请求（换轮、声明、收尾清理、断开）。
 * 判定类请求（`turn-stopping` / `upstream-error` / `resume-confirm`）绝不能进缓存：
 * 它们的答案随状态变化，而同一轮会被问多次——门注入后宿主再跑一步，轮末又会
 * 问一次。缓存回放会让"已声明"永远看不到，注入无限重复，且短路发生在 dispatch
 * 之前，连留痕都不会写（实测表现为每轮都收到同一条 `attempt 1` 提醒、留痕为零）。
 */
const CACHED_TYPES = new Set<RequestMessage['type']>(['turn-start', 'declare', 'finish', 'dispose'])

const results = new Map<string, unknown>()

/**
 * 把结束原因字符串归一化为内部的三态。
 *
 * 协议传的是宿主 `FinishReason.kind` 的字符串形式，这里复用同一套归一化，
 * 避免"客户端与守护进程各判断一次"导致口径不一。
 * @param kind - 协议中的结束原因
 * @returns 归一化原因
 */
function causeOf(kind: string | undefined): StopCause {
  if (kind === undefined) return 'undeclared'
  if (kind === 'max-tokens') return 'truncated'
  if (kind === 'aborted' || kind === 'error') return 'not-applicable'
  return 'undeclared'
}

/**
 * 处理一条请求。
 * @param deps - 副作用依赖
 * @param request - 已通过协议校验的请求
 * @returns 分发结果
 */
export function handleRequest(deps: ServerDeps, request: RequestMessage): HandleResult {
  const cacheable = CACHED_TYPES.has(request.type)
  const key = `${request.sessionId}:${request.turn}:${request.type}`
  if (cacheable) {
    const cached = results.get(key)
    if (cached !== undefined) return { ok: true, data: cached }
  }

  const now = deps.now()
  const data = dispatch(deps, request, now)

  if (!cacheable) return { ok: true, data }

  results.set(key, data)
  if (results.size > IDEMPOTENCY_CAPACITY) {
    // 按插入顺序淘汰最旧的一条；不追求 LRU，这里只需要有界。
    const oldest = results.keys().next()
    if (!oldest.done) results.delete(oldest.value)
  }
  return { ok: true, data }
}

/**
 * 实际执行一条请求；异常由调用方统一转成 `E_INTERNAL`。
 * @param deps - 副作用依赖
 * @param request - 请求
 * @param now - 统一的当前时刻
 * @returns 返回数据
 */
function dispatch(deps: ServerDeps, request: RequestMessage, now: number): unknown {
  switch (request.type) {
    case 'turn-start': {
      turnStart(request.sessionId, request.turn, now)
      return {}
    }

    case 'declare': {
      const state = request.state ?? 'done'
      const result = declare(request.sessionId, request.turn, state, now, request.config.reactionWindowMs)
      return result
    }

    case 'turn-stopping': {
      const cause = causeOf(request.finishKind)
      const result: TurnStoppingData = turnStopping({
        sessionId: request.sessionId,
        turn: request.turn,
        cause,
        aborted: request.aborted === true,
        isRoot: request.isRoot === true,
        config: request.config,
        now,
      })
      // 放行也留痕：只有"查不到记录"才代表该轮未被判定（spec 004 / FR-001）。
      deps.trace(request.sessionId, {
        turn: request.turn,
        outcome: result.inject ? 'injected' : 'released',
        reason: result.reason,
        attempt: result.attempt,
      })
      return result
    }

    case 'upstream-error': {
      const retryable = request.retryable === true
      if (!retryable) {
        // 不可重试的错误不进入续行计数，只留一条痕迹供事后归因。
        deps.trace(request.sessionId, {
          turn: request.turn,
          outcome: 'released',
          reason: 'upstream-skipped',
          attempt: 0,
          ...(request.errorCode === undefined ? {} : { errorCode: request.errorCode }),
        })
        return { resume: false, reason: 'non-retryable' }
      }
      return upstreamError({ sessionId: request.sessionId, turn: request.turn, config: request.config, now })
    }

    case 'resume-confirm': {
      const result = resumeConfirm({
        sessionId: request.sessionId,
        turn: request.turn,
        config: request.config,
        now,
      })
      deps.trace(request.sessionId, {
        turn: request.turn,
        outcome: result.resume ? 'injected' : 'released',
        reason: result.resume ? 'upstream-resumed' : 'upstream-capped',
        attempt: result.resume ? 1 : 0,
        ...(request.errorCode === undefined ? {} : { errorCode: request.errorCode }),
      })
      return result
    }

    case 'finish': {
      finish(request.sessionId, request.turn, request.finishKind ?? 'stop', now)
      return {}
    }

    case 'dispose': {
      forgetSession(request.sessionId)
      return {}
    }
  }
}

/** 清空幂等缓存；仅供测试使用。 */
export function resetServerState(): void {
  results.clear()
}
