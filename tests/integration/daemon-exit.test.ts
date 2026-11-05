/**
 * 集成测试：宽限退出的**生产路径**（spec 007 / FR-018）。
 *
 * 为什么必须真起一个子进程：默认退出回调是 `process.exit(0)`，任何在测试进程内
 * 注入 `onExit` 的写法都会把它换掉，于是"退出时是否清理文件"这件事被掩盖——
 * 本文件出现之前，`daemon-ipc.test.ts` 的宽限用例正是这样通过的：它注入的
 * `onExit` 自己调了 `daemon.close()`，而生产路径并没有这一步。
 *
 * 因此这里 spawn 真实入口，只观察外部可见结果：进程是否退出、文件是否消失。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectClient } from '../../src/ipc/client.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = resolve(root, 'src/daemon/main.ts')

/** 等到文件出现或超时。 */
async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`等待超时：${path}`)
}

test('最后一个客户端断开后，宽限期到点退出并删除 socket 与 pid 文件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-exit-'))
  const socketPath = join(home, 'run', 'target-monitor.sock')
  const pidPath = join(home, 'run', 'target-monitor.pid')

  const child = spawn(
    process.execPath,
    [entry, '--socket', socketPath, '--pid', pidPath, '--grace', '80'],
    { stdio: 'ignore' },
  )
  const exited = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => resolveExit(code))
  })

  try {
    await waitForFile(socketPath)
    const client = await connectClient({ socketPath })
    client.close()

    // 宽限 80ms + 退出与清理的余量。
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('守护进程在宽限期结束后仍未退出')), 5000),
      ),
    ])

    assert.equal(code, 0, '宽限退出应当是正常退出')
    assert.equal(existsSync(socketPath), false, 'socket 文件必须被清理，不能留给下一个客户端收')
    assert.equal(existsSync(pidPath), false, 'pid 文件必须被清理')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})
