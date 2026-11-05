/**
 * 守护进程 IPC 协议（v1）：编解码、字段校验与错误码。
 *
 * 传输是 unix socket 上的「一行一条 JSON」。选 NDJSON 而不是长度前缀，是因为
 * 它可以直接用 `readline` 拆分、可以直接 `cat` 出来看、日志里也好读；代价是
 * 单行有上限，因此所有写入前都要过一次长度检查。
 *
 * 校验集中在这里：守护进程收到的每一行都来自另一个进程，属于不可信输入，
 * 必须在边界处一次性挡住，不能让半成品对象流进状态表。
 * @module
 */
import type { GateReason } from '../trace.ts'

/** 当前协议版本；不兼容变更必须递增（契约 C-012）。 */
export const PROTOCOL_VERSION = 1

/** 单行上限；超过即断开连接（契约 C-006 的前置）。 */
export const MAX_LINE_BYTES = 64 * 1024

/** 幂等缓存容量（契约 C-008）。 */
export const IDEMPOTENCY_CAPACITY = 256

/** 请求类型。 */
export type RequestType =
  | 'turn-start'
  | 'declare'
  | 'turn-stopping'
  | 'upstream-error'
  | 'resume-confirm'
  | 'finish'
  | 'dispose'

/** 配置快照：客户端每次请求带上，守护进程不持有配置（R-012）。 */
export interface MonitorConfigSnapshot {
  enabled: boolean
  stallNoticeThreshold: number
  reminderThreshold: number
  reactionWindowMs: number
  resumeOnUpstreamError: boolean
  maxResumes: number
  declarationSection: boolean
}

/** 收尾判定的返回数据。 */
export interface TurnStoppingData {
  inject: boolean
  reason: GateReason
  attempt: number
  reminder: boolean
  stallNotice: boolean
  cause: 'truncated' | 'undeclared' | 'not-applicable'
}

/** 声明返回的数据。 */
export interface DeclareData {
  forgetCount: number
  counted: boolean
}

/** 续行判定返回的数据。 */
export interface ResumeData {
  resume: boolean
  reason: string
}

/** 客户端 → 守护进程的请求。 */
export interface RequestMessage {
  type: RequestType
  requestId: string
  sessionId: string
  turn: number
  config: MonitorConfigSnapshot
  state?: 'done' | 'awaiting_user'
  finishKind?: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
  aborted?: boolean
  isRoot?: boolean
  errorCode?: string
  /** 上游错误是否可重试；仅 `upstream-error` 使用，由客户端分类后带上。 */
  retryable?: boolean
}

/** 握手。 */
export interface HelloMessage {
  type: 'hello'
  protocol: number
  clientId: string
  pid: number
}

/** 正常断开。 */
export interface ByeMessage {
  type: 'bye'
}

/** 客户端可能发出的全部消息。 */
export type ClientMessage = HelloMessage | RequestMessage | ByeMessage

/** 守护进程 → 客户端的成功响应。 */
export interface OkMessage {
  type: 'ok'
  requestId: string
  data: unknown
}

/** 守护进程 → 客户端的错误响应。 */
export interface ErrorMessage {
  type: 'error'
  requestId: string
  code: string
  message: string
}

/** 握手成功。 */
export interface WelcomeMessage {
  type: 'welcome'
  protocol: number
  serverPid: number
}

/** 握手失败，连接随即关闭。 */
export interface FatalMessage {
  type: 'fatal'
  reason: string
  expected?: number
  received?: number
}

/** 守护进程可能发出的全部消息。 */
export type ServerMessage = OkMessage | ErrorMessage | WelcomeMessage | FatalMessage

/** 错误码。 */
export const ERROR_CODES = {
  badRequest: 'E_BAD_REQUEST',
  unknownSession: 'E_UNKNOWN_SESSION',
  oversize: 'E_OVERSIZE',
  internal: 'E_INTERNAL',
} as const

/** 解析结果；失败时带错误码与说明。 */
export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

/** 校验辅助：非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** 校验辅助：非负整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** 校验辅助：布尔。 */
function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/**
 * 校验配置快照。
 *
 * 缺字段时**不拒绝**，而是用默认值补齐——守护进程不能因为客户端少传一个字段
 * 就整体拒绝服务，那样一个版本差异会放大成功能不可用。
 * @param raw - 原始值
 * @returns 补齐后的快照
 */
export function normalizeConfig(raw: unknown): MonitorConfigSnapshot {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const numberOr = (value: unknown, fallback: number, allowZero = false): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
    if (value < 0) return fallback
    if (value === 0 && !allowZero) return fallback
    return value
  }
  return {
    enabled: isBoolean(source['enabled']) ? source['enabled'] : true,
    stallNoticeThreshold: numberOr(source['stallNoticeThreshold'], 5),
    reminderThreshold: numberOr(source['reminderThreshold'], 3),
    reactionWindowMs: numberOr(source['reactionWindowMs'], 30_000),
    resumeOnUpstreamError: isBoolean(source['resumeOnUpstreamError']) ? source['resumeOnUpstreamError'] : true,
    maxResumes: numberOr(source['maxResumes'], 3, true),
    declarationSection: isBoolean(source['declarationSection']) ? source['declarationSection'] : true,
  }
}

/**
 * 编码一条消息。
 * @param message - 待编码消息
 * @returns 以换行结尾的单行字符串
 */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * 解码一行。
 *
 * 只做「是不是一条合法请求」的判定，不做语义判断（那属于状态层）。
 * @param line - 去掉换行后的一行
 * @returns 解码结果
 */
export function decodeMessage(line: string): DecodeResult<ClientMessage | ServerMessage> {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return { ok: false, code: ERROR_CODES.oversize, message: 'line exceeds 64 KiB' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'not valid JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'message must be an object' }
  }

  const candidate = parsed as Record<string, unknown>
  const type = candidate['type']
  if (type === 'hello' || type === 'bye' || type === 'ok' || type === 'error' || type === 'welcome' || type === 'fatal') {
    // 这几类由各自的一端处理，这里只放行结构，不做深度校验。
    return { ok: true, value: parsed as ClientMessage | ServerMessage }
  }

  if (typeof type !== 'string') {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'type is required' }
  }
  const known: readonly string[] = [
    'turn-start',
    'declare',
    'turn-stopping',
    'upstream-error',
    'resume-confirm',
    'finish',
    'dispose',
  ]
  if (!known.includes(type)) {
    return { ok: false, code: ERROR_CODES.badRequest, message: `unknown type: ${type}` }
  }

  if (!isNonEmptyString(candidate['requestId'])) {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'requestId is required' }
  }
  if (!isNonEmptyString(candidate['sessionId']) || candidate['sessionId'].length > 128) {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'sessionId must be a non-empty string up to 128 chars' }
  }
  if (!isNonNegativeInteger(candidate['turn'])) {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'turn must be a non-negative integer' }
  }
  if (type === 'declare' && candidate['state'] !== 'done' && candidate['state'] !== 'awaiting_user') {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'state must be done or awaiting_user' }
  }
  if (type === 'finish') {
    const kind = candidate['finishKind']
    const kinds: readonly string[] = ['stop', 'tool-calls', 'max-tokens', 'aborted', 'error']
    if (typeof kind !== 'string' || !kinds.includes(kind)) {
      return { ok: false, code: ERROR_CODES.badRequest, message: 'finishKind is required for finish' }
    }
  }
  if (type === 'turn-stopping' && !isBoolean(candidate['aborted'])) {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'aborted is required for turn-stopping' }
  }
  if (type === 'turn-stopping' && !isBoolean(candidate['isRoot'])) {
    return { ok: false, code: ERROR_CODES.badRequest, message: 'isRoot is required for turn-stopping' }
  }

  return {
    ok: true,
    value: {
      ...(candidate as unknown as RequestMessage),
      config: normalizeConfig(candidate['config']),
    },
  }
}

/**
 * 判断消息是否为请求（相对于握手与断开）。
 * @param message - 已解码的消息
 * @returns 是否为请求
 */
export function isRequest(message: ClientMessage | ServerMessage): message is RequestMessage {
  return (
    message.type === 'turn-start' ||
    message.type === 'declare' ||
    message.type === 'turn-stopping' ||
    message.type === 'upstream-error' ||
    message.type === 'resume-confirm' ||
    message.type === 'finish' ||
    message.type === 'dispose'
  )
}
