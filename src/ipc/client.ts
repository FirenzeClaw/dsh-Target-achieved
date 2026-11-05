/**
 * 守护进程客户端：连接、握手、请求/响应关联。
 *
 * 一个进程只保留一个连接（`RemoteMonitor` 持有它）。请求按 `requestId` 关联，
 * 因此并发请求不会串号；单请求超时只影响那一条，不会拖垮连接。
 * @module
 */
import { connect, type Socket } from 'node:net'
import {
  decodeMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type RequestMessage,
  type ServerMessage,
} from './protocol.ts'

/** 单请求默认超时；超过即认为守护进程不可用（FR-010）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 200

/** 建连默认超时；与拉起的重试预算一致（FR-002）。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

/** 协议版本不匹配。遇到它不应重试，只降级（契约 C-013）。 */
export class ProtocolMismatchError extends Error {
  /** 对端声明的协议版本。 */
  readonly received: number

  /**
   * @param received - 对端声明的协议版本
   */
  constructor(received: number) {
    super(`target-monitor: daemon protocol ${String(received)} is not compatible with ${String(PROTOCOL_VERSION)}`)
    this.name = 'ProtocolMismatchError'
    this.received = received
  }
}

/** 连接或请求失败。 */
export class IpcError extends Error {
  /** 稳定错误码。 */
  readonly code: string

  /**
   * @param message - 说明
   * @param code - 稳定错误码
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
  }
}

/** 客户端接口。 */
export interface DaemonClient {
  /** 发一条请求并等待结果。 */
  request(message: Omit<RequestMessage, 'requestId'>): Promise<unknown>
  /** 关闭连接。 */
  close(): void
  /** 是否已关闭。 */
  readonly closed: boolean
}

/** 未完成的请求。 */
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/** 生成客户端标识。 */
export function makeClientId(): string {
  return `${process.pid}-${Math.random().toString(16).slice(2, 8)}`
}

/**
 * 建立连接并完成握手。
 * @param options - socket 路径、客户端标识与超时
 * @returns 客户端
 * @throws {ProtocolMismatchError} 守护进程协议版本不兼容
 * @throws {IpcError} 连接失败或握手失败
 */
export function connectClient(options: {
  socketPath: string
  clientId?: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}): Promise<DaemonClient> {
  const clientId = options.clientId ?? makeClientId()
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  return new Promise<DaemonClient>((resolvePromise, rejectPromise) => {
    const socket: Socket = connect(options.socketPath)
    const pending = new Map<string, Pending>()
    let sequence = 0
    let buffer = ''
    let closed = false
    let handshakeDone = false

    const connectTimer = setTimeout(() => {
      socket.destroy()
      rejectPromise(new IpcError('target-monitor: daemon connect timed out', 'E_TIMEOUT'))
    }, connectTimeoutMs)
    connectTimer.unref()

    /**
     * 拒绝所有未完成请求；连接一断它们都不可能再有结果。
     * @param error - 拒绝原因
     */
    const failAll = (error: Error): void => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }

    socket.setEncoding('utf8')

    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        handleLine(line)
        index = buffer.indexOf('\n')
      }
    })

    socket.on('error', (error: Error) => {
      clearTimeout(connectTimer)
      if (!handshakeDone) {
        rejectPromise(new IpcError(`target-monitor: daemon connect failed: ${error.message}`, 'E_CONNECT'))
        return
      }
      failAll(new IpcError(`target-monitor: daemon socket error: ${error.message}`, 'E_SOCKET'))
    })

    socket.on('close', () => {
      closed = true
      clearTimeout(connectTimer)
      if (!handshakeDone) {
        rejectPromise(new IpcError('target-monitor: daemon closed before handshake', 'E_CONNECT'))
        return
      }
      failAll(new IpcError('target-monitor: daemon connection closed', 'E_CLOSED'))
    })

    socket.on('connect', () => {
      socket.write(encodeMessage({ type: 'hello', protocol: PROTOCOL_VERSION, clientId, pid: process.pid }))
    })

    /**
     * 处理服务端的一行消息。
     * @param line - 一行 JSON
     */
    function handleLine(line: string): void {
      if (line.trim() === '') return
      const decoded = decodeMessage(line)
      if (!decoded.ok) return

      const message = decoded.value as ServerMessage
      if (message.type === 'welcome') {
        clearTimeout(connectTimer)
        handshakeDone = true
        resolvePromise({
          request(message_: Omit<RequestMessage, 'requestId'>): Promise<unknown> {
            return sendRequest(message_)
          },
          close(): void {
            if (closed) return
            socket.write(encodeMessage({ type: 'bye' }))
            socket.end()
          },
          get closed(): boolean {
            return closed
          },
        })
        return
      }

      if (message.type === 'fatal') {
        clearTimeout(connectTimer)
        socket.destroy()
        rejectPromise(new ProtocolMismatchError(message.received ?? -1))
        return
      }

      if (message.type === 'ok' || message.type === 'error') {
        const entry = pending.get(message.requestId)
        if (entry === undefined) return
        pending.delete(message.requestId)
        clearTimeout(entry.timer)
        if (message.type === 'ok') entry.resolve(message.data)
        else entry.reject(new IpcError(message.message, message.code))
      }
    }

    /**
     * 发送一条请求。
     * @param message - 不含 requestId 的请求
     * @returns 服务端返回的数据
     */
    function sendRequest(message: Omit<RequestMessage, 'requestId'>): Promise<unknown> {
      if (closed) return Promise.reject(new IpcError('target-monitor: daemon connection closed', 'E_CLOSED'))
      sequence += 1
      const requestId = `${clientId}:${String(sequence)}`

      return new Promise<unknown>((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          rejectRequest(new IpcError('target-monitor: daemon request timed out', 'E_TIMEOUT'))
        }, requestTimeoutMs)
        timer.unref()

        pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer })
        socket.write(encodeMessage({ ...message, requestId }))
      })
    }
  })
}
