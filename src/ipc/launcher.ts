/**
 * 守护进程的拉起与陈旧 socket 清理。
 *
 * 关键点是「只在确认进程已死时才删文件」。仅凭 `ECONNREFUSED` 就 unlink 会踩到
 * 一个很窄但真实存在的窗口：守护进程刚 `bind` 完、还没 `listen` 时，另一个
 * 客户端连上来也会得到拒绝，此时删文件会把正在启动的守护进程打成孤儿。
 * @module
 */
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 探测结果。 */
export type ProbeResult = 'ok' | 'missing' | 'refused'

/** 拉起重试间隔。 */
const RETRY_INTERVAL_MS = 50

/** 拉起总预算。 */
const RETRY_BUDGET_MS = 5_000

/**
 * 探测某个 socket 是否有人监听。
 * @param socketPath - socket 路径
 * @returns 探测结果
 */
export function probe(socketPath: string): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolveProbe) => {
    const socket = connect(socketPath)
    const done = (result: ProbeResult): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolveProbe(result)
    }
    socket.once('connect', () => {
      done('ok')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ENOENT' ? 'missing' : 'refused')
    })
  })
}

/**
 * 判断 pid 文件里的进程是否还活着。
 * @param pidPath - pid 文件路径
 * @returns 是否存活；文件缺失或内容非法时视为不存活
 */
export function isPidAlive(pidPath: string): boolean {
  if (!existsSync(pidPath)) return false
  let pid = 0
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    // 信号 0 只做存在性检查，不真的发信号。
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM 说明进程存在但不属于当前用户——仍算活着，不能删它的 socket。
    return code === 'EPERM'
  }
}

/**
 * 清理陈旧文件。
 * @param socketPath - socket 路径
 * @param pidPath - pid 文件路径
 * @returns 是否执行了清理
 */
export function cleanStale(socketPath: string, pidPath: string): boolean {
  if (isPidAlive(pidPath)) return false
  for (const path of [socketPath, pidPath]) {
    try {
      unlinkSync(path)
    } catch {
      // 不存在即无需清理。
    }
  }
  return true
}

/**
 * 解析守护进程入口文件的位置。
 *
 * 构建产物与本文件同目录（`dist/ipc/` → `dist/daemon/main.js`），
 * 因此相对 `import.meta.url` 解析，不依赖安装路径。
 * @returns 入口文件的绝对路径
 */
export function daemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'daemon', 'main.js')
}

/**
 * 确保守护进程可用：必要时拉起，并等待到可连接。
 * @param options - 路径与拉起参数
 * @returns 最终探测结果
 */
export async function ensureDaemon(options: {
  socketPath: string
  pidPath: string
  entryPath?: string
  budgetMs?: number
}): Promise<ProbeResult> {
  const initial = await probe(options.socketPath)
  if (initial === 'ok') return 'ok'

  if (initial === 'refused') {
    // 有文件但无人监听：确认进程确实死了才清理，否则可能打断启动中的守护进程。
    if (!cleanStale(options.socketPath, options.pidPath)) return 'refused'
  }

  const entry = options.entryPath ?? daemonEntry()
  const child = spawn(process.execPath, [entry, '--socket', options.socketPath, '--pid', options.pidPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  // 不 unref 会拖住父进程的事件循环，DSH 退出时被它拽住。
  child.unref()

  const deadline = Date.now() + (options.budgetMs ?? RETRY_BUDGET_MS)
  while (Date.now() < deadline) {
    const result = await probe(options.socketPath)
    if (result === 'ok') return 'ok'
    await new Promise((resolveWait) => setTimeout(resolveWait, RETRY_INTERVAL_MS))
  }
  return 'refused'
}
