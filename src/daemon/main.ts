/**
 * 守护进程入口。
 *
 * 生命周期由连接计数驱动：最后一个客户端断开后等 30 秒，期间没有新连接就退出。
 * 这个宽限是必要的——用户常常关一个窗口就开另一个，立刻退出会让守护进程
 * 反复重启，反而更慢。
 *
 * 监听器与定时器都已 `unref()`：没有连接、也没有宽限计时的时候，进程必须能
 * 自然退出，否则它会变成用户机器上一个永远不退的空壳。
 * @module
 */
import { createServer } from 'node:net'
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { decodeMessage, encodeMessage, ERROR_CODES, isRequest, PROTOCOL_VERSION, type ClientMessage, type RequestMessage } from '../ipc/protocol.ts'
import { configureTrace, recordTraceForSession } from '../trace.ts'
import { handleRequest, type ServerDeps } from './server.ts'
import { sweep } from './state.ts'

/** 最后一个连接断开后的宽限时长（默认值；测试可覆盖）。 */
const DEFAULT_GRACE_MS = 30_000

/** 当前实例使用的宽限时长。 */
let graceMs = DEFAULT_GRACE_MS

/** 闲置会话回收的检查间隔。 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** 宽限到期时的动作（每个实例各自持有）。 */
type ExitHandler = () => void

/**
 * 解析命令行参数。
 * @param argv - `process.argv.slice(2)`
 * @returns socket 与 pid 文件路径
 */
export function parseArgs(argv: readonly string[]): { socketPath: string; pidPath: string } {
  let socketPath = ''
  let pidPath = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--socket') socketPath = argv[index + 1] ?? ''
    if (arg === '--pid') pidPath = argv[index + 1] ?? ''
  }
  if (socketPath === '') throw new Error('target-monitor daemon: --socket is required')
  if (pidPath === '') throw new Error('target-monitor daemon: --pid is required')
  return { socketPath: resolve(socketPath), pidPath: resolve(pidPath) }
}

/**
 * 启动守护进程。
 * @param options - socket 与 pid 路径
 * @returns 关闭函数（测试用）
 */
export function startDaemon(options: {
  socketPath: string
  pidPath: string
  /** 宽限时长；测试用它把 30 秒缩短到毫秒级。 */
  graceMs?: number
  /** 退出回调；默认 `process.exit(0)`，测试里换成标记以便断言。 */
  onExit?: () => void
}): { close(): void; server: ReturnType<typeof createServer> } {
  const instanceGraceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const exitHandler: ExitHandler = options.onExit ?? (() => { process.exit(0) })

  // 连接数与计时器必须属于实例而不是模块：一个进程里可能有多个 server
  // （测试就是这种情况），共享计数会让"最后一个连接断开"永远不成立。
  let connections = 0
  let graceTimer: NodeJS.Timeout | undefined

  /**
   * 安排宽限退出。
   *
   * 只有在连接数为零时才计时；计时器 `unref()` 后不阻止进程退出，
   * 但监听中的 server 一旦 `close` 就没有活跃句柄，进程会自然结束。
   */
  const scheduleExit = (): void => {
    if (connections > 0) return
    if (graceTimer !== undefined) return

    graceTimer = setTimeout(() => {
      graceTimer = undefined
      if (connections > 0) return
      exitHandler()
    }, instanceGraceMs)
    graceTimer.unref()
  }

  // 目录 0700、socket 0600：IPC 是本机的权限边界，同机其他用户不该能连上来写状态。
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 })
  // 先清掉可能残留的 socket：走到这里说明调用方已确认无人监听，
  // 但 bind 仍会因为文件存在而 EADDRINUSE。
  try {
    unlinkSync(options.socketPath)
  } catch {
    // 文件不存在是正常情况，无需处理。
  }

  const deps: ServerDeps = {
    now: () => Date.now(),
    trace(rawSessionId, input) {
      recordTraceForSession(rawSessionId, input, false)
    },
  }

  const server = createServer((socket) => {
    connections += 1
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }

    let handshaken = false
    let buffer = ''

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk

      // 单行上限：超长说明对端协议不对或已损坏，直接断开而不是无限缓冲。
      if (buffer.length > 64 * 1024 * 2 && !buffer.includes('\n')) {
        socket.destroy()
        return
      }

      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        handleLine(line)
        newlineIndex = buffer.indexOf('\n')
      }
    })

    socket.on('error', () => {
      // 客户端异常断开是常态（进程被杀、窗口关闭），不当作错误上报。
    })

    socket.on('close', () => {
      connections -= 1
      scheduleExit()
    })

    /**
     * 处理一行输入。
     * @param line - 一行 JSON
     */
    function handleLine(line: string): void {
      if (line.trim() === '') return

      const decoded = decodeMessage(line)
      if (!decoded.ok) {
        socket.write(encodeMessage({ type: 'error', requestId: '', code: decoded.code, message: decoded.message }))
        return
      }

      const message: ClientMessage = decoded.value as ClientMessage

      if (message.type === 'hello') {
        if (message.protocol !== PROTOCOL_VERSION) {
          socket.write(
            encodeMessage({
              type: 'fatal',
              reason: 'protocol',
              expected: PROTOCOL_VERSION,
              received: message.protocol,
            }),
          )
          socket.end()
          return
        }
        handshaken = true
        socket.write(encodeMessage({ type: 'welcome', protocol: PROTOCOL_VERSION, serverPid: process.pid }))
        return
      }

      if (message.type === 'bye') {
        socket.end()
        return
      }

      // 未握手就发请求：按协议错误处理，避免旧客户端连上来直接写状态。
      if (!handshaken) {
        socket.write(encodeMessage({ type: 'error', requestId: '', code: ERROR_CODES.badRequest, message: 'hello required' }))
        return
      }

      if (!isRequest(message as ClientMessage)) return

      const request = message as RequestMessage
      try {
        const result = handleRequest(deps, request)
        socket.write(encodeMessage({ type: 'ok', requestId: request.requestId, data: result.ok ? result.data : undefined }))
      } catch (error: unknown) {
        // 单请求异常不得让进程退出（FR-013）：回一条错误，继续服务。
        socket.write(
          encodeMessage({
            type: 'error',
            requestId: request.requestId,
            code: ERROR_CODES.internal,
            message: error instanceof Error ? error.message : 'internal error',
          }),
        )
      }
    }
  })

  server.listen(options.socketPath, () => {
    writeFileSync(options.pidPath, `${process.pid}\n`, { mode: 0o600 })
    // Node 建 socket 时用的是 umask 决定的默认权限（常见 0775），
    // 必须在 listen 之后显式收紧，否则同机其他用户可以连上来改状态。
    try {
      chmodSync(options.socketPath, 0o600)
    } catch (error: unknown) {
      console.warn('target-monitor: 收紧 socket 权限失败，继续以默认权限运行', error)
    }
  })
  // 这里绝不能 unref：未 ref 的监听器不持有事件循环，进程会在 listen 后立刻退出。

  const sweeper = setInterval(() => {
    sweep(Date.now())
  }, SWEEP_INTERVAL_MS)
  sweeper.unref()

  return {
    server,
    close() {
      clearInterval(sweeper)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      server.close()
      cleanupFiles(options)
    },
  }
}

/**
 * 清理 socket 与 pid 文件。
 * @param options - 路径
 */
function cleanupFiles(options: { socketPath: string; pidPath: string }): void {
  for (const path of [options.socketPath, options.pidPath]) {
    try {
      unlinkSync(path)
    } catch {
      // 已经不存在，忽略。
    }
  }
}

// 直接执行时启动；被 import 时只导出（便于测试）。
if (process.argv[1]?.endsWith('main.js') === true) {
  const options = parseArgs(process.argv.slice(2))
  configureTrace({})
  startDaemon(options)

  const shutdown = (): void => {
    cleanupFiles(options)
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
