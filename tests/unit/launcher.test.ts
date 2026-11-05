/**
 * 拉起与陈旧 socket 的单元测试。
 *
 * 这里最容易写错的是「什么时候可以删文件」：删早了会打断正在启动的守护进程，
 * 删晚了会让后续启动一直连不上。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanStale, isPidAlive, probe } from '../../src/ipc/launcher.ts'

/** 建一个临时目录。 */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tm-launch-'))
}

test('pid 文件不存在时视为不存活', () => {
  assert.equal(isPidAlive(join(tmp(), 'nope.pid')), false)
})

test('pid 文件内容非法时视为不存活', () => {
  const dir = tmp()
  const path = join(dir, 'bad.pid')
  writeFileSync(path, 'not-a-number\n')
  assert.equal(isPidAlive(path), false)
})

test('当前进程的 pid 判定为存活', () => {
  const dir = tmp()
  const path = join(dir, 'self.pid')
  writeFileSync(path, `${process.pid}\n`)
  assert.equal(isPidAlive(path), true)
})

test('已退出进程的 pid 判定为不存活', async () => {
  // 起一个立刻退出的子进程，取它的 pid。
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  const dir = tmp()
  const path = join(dir, 'dead.pid')
  writeFileSync(path, `${result.pid}\n`)
  assert.equal(isPidAlive(path), false)
})

test('进程存活时不清陈旧文件', () => {
  const dir = tmp()
  const socketPath = join(dir, 'a.sock')
  const pidPath = join(dir, 'a.pid')
  writeFileSync(socketPath, '')
  writeFileSync(pidPath, `${process.pid}\n`)

  assert.equal(cleanStale(socketPath, pidPath), false)
  assert.equal(existsSync(socketPath), true, '进程还活着，socket 不能被删')
})

test('进程已死时清理 socket 与 pid 文件', async () => {
  const { spawnSync } = await import('node:child_process')
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  const dir = tmp()
  const socketPath = join(dir, 'a.sock')
  const pidPath = join(dir, 'a.pid')
  writeFileSync(socketPath, '')
  writeFileSync(pidPath, `${dead.pid}\n`)

  assert.equal(cleanStale(socketPath, pidPath), true)
  assert.equal(existsSync(socketPath), false)
  assert.equal(existsSync(pidPath), false)
})

test('探测不存在的 socket 返回 missing', async () => {
  assert.equal(await probe(join(tmp(), 'nope.sock')), 'missing')
})

test('探测存在但无人监听的 socket 返回 refused', async () => {
  const dir = tmp()
  const socketPath = join(dir, 'stale.sock')
  // 普通文件即可模拟：connect 会得到 ECONNREFUSED。
  writeFileSync(socketPath, '')
  assert.equal(await probe(socketPath), 'refused')
})
