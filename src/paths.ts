/**
 * 宿主目录解析。
 *
 * 与宿主一致：`$DSH_HOME` → `~/.dsh` → 临时目录
 * （`dsh-home-paths/lib/index.js:15` 的同一条规则）。守护进程的 socket 与 pid
 * 文件也落在这里，因此不同 `DSH_HOME` 的实例天然互不干扰。
 * @module
 */
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * 取宿主根目录。
 * @returns 绝对路径
 */
export function dshHome(): string {
  const explicit = process.env['DSH_HOME']
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return join(homedir() || tmpdir(), '.dsh')
}

/**
 * 取 runtime 目录（socket 与 pid 文件）。
 * @returns 绝对路径
 */
export function runDir(): string {
  return join(dshHome(), 'run')
}

/**
 * 取 socket 路径。
 * @returns 绝对路径
 */
export function socketPath(): string {
  return join(runDir(), 'target-monitor.sock')
}

/**
 * 取 pid 文件路径。
 * @returns 绝对路径
 */
export function pidPath(): string {
  return join(runDir(), 'target-monitor.pid')
}

/**
 * 确保 runtime 目录存在且仅当前用户可访问。
 *
 * 权限 0700：socket 是 IPC 权限边界，同机其他用户不该能连上来写状态。
 * @returns runtime 目录的绝对路径
 */
export function ensureRunDir(): string {
  const dir = runDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
