/**
 * 守护进程的集成测试：真实 socket、真实状态表、两个客户端。
 *
 * 这里不 mock IPC：跨进程共享的价值就在于「两个进程看到同一份状态」，
 * 用假的传输层测不出这句话是否成立。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { startDaemon } from '../../src/daemon/main.ts'
import { connectClient, type DaemonClient } from '../../src/ipc/client.ts'
import type { MonitorConfigSnapshot } from '../../src/ipc/protocol.ts'
import { configureTrace } from '../../src/trace.ts'

const config: MonitorConfigSnapshot = {
  enabled: true,
  stallNoticeThreshold: 5,
  reminderThreshold: 3,
  reactionWindowMs: 30_000,
  resumeOnUpstreamError: true,
  maxResumes: 3,
  declarationSection: true,
}

/** 建一个临时目录并启动守护进程。 */
function setup(options: { graceMs?: number } = {}): {
  socketPath: string
  daemon: { close(): void }
  home: string
} {
  const home = mkdtempSync(join(tmpdir(), 'tm-daemon-'))
  const socketPath = join(home, 'run', 'target-monitor.sock')
  const pidPath = join(home, 'run', 'target-monitor.pid')
  const daemon = startDaemon({ socketPath, pidPath, graceMs: options.graceMs ?? 60_000 })
  return { socketPath, daemon, home }
}

/** 等待 socket 出现（守护进程 listen 是异步的）。 */
async function waitForSocket(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error(`socket did not appear: ${path}`)
}

const cleanups: (() => void)[] = []
after(() => {
  for (const cleanup of cleanups) cleanup()
})

test('两个客户端共享同一份遗忘计数：第 4 次注入带复述', async () => {
  const { socketPath, daemon, home } = setup()
  cleanups.push(() => {
    daemon.close()
  })
  await waitForSocket(socketPath)

  // 留痕落到临时目录，避免污染真实 ~/.dsh。
  configureTrace({ dir: join(home, 'logs') })

  const a: DaemonClient = await connectClient({ socketPath })
  const b: DaemonClient = await connectClient({ socketPath })
  cleanups.push(() => {
    a.close()
    b.close()
  })

  const reminders: boolean[] = []
  for (let turn = 1; turn <= 4; turn += 1) {
    const client = turn % 2 === 1 ? a : b
    await client.request({ type: 'turn-start', sessionId: 'shared', turn, config })
    const result = (await client.request({
      type: 'turn-stopping',
      sessionId: 'shared',
      turn,
      finishKind: 'stop',
      aborted: false,
      isRoot: true,
      config,
    })) as { reminder: boolean }
    reminders.push(result.reminder)
    if (turn < 4) {
      // 窗口内补声明，计一次遗忘
      await client.request({ type: 'declare', sessionId: 'shared', turn, state: 'done', config })
    }
  }

  // 阈值 3：前三次注入时计数还没攒够，第四次才带复述。
  assert.deepEqual(reminders, [false, false, false, true])
})

test('留痕由守护进程单写，且每行都是合法 JSON', async () => {
  const { socketPath, daemon, home } = setup()
  cleanups.push(() => {
    daemon.close()
  })
  await waitForSocket(socketPath)
  configureTrace({ dir: join(home, 'logs') })

  const client = await connectClient({ socketPath })
  cleanups.push(() => {
    client.close()
  })

  for (let turn = 1; turn <= 20; turn += 1) {
    await client.request({ type: 'turn-start', sessionId: 's', turn, config })
    await client.request({
      type: 'turn-stopping',
      sessionId: 's',
      turn,
      finishKind: 'stop',
      aborted: false,
      isRoot: true,
      config,
    })
  }

  const raw = readFileSync(join(home, 'logs', 'gate-trace.jsonl'), 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 20)
  for (const line of lines) {
    const parsed = JSON.parse(line) as { reason: string; outcome: string }
    assert.equal(parsed.reason, 'undeclared')
    assert.equal(parsed.outcome, 'injected')
  }
})

test('同一请求重复发送只生效一次（幂等）', async () => {
  const { socketPath, daemon } = setup()
  cleanups.push(() => {
    daemon.close()
  })
  await waitForSocket(socketPath)

  const client = await connectClient({ socketPath })
  cleanups.push(() => {
    client.close()
  })

  await client.request({ type: 'turn-start', sessionId: 's', turn: 1, config })
  const first = (await client.request({
    type: 'turn-stopping',
    sessionId: 's',
    turn: 1,
    finishKind: 'stop',
    aborted: false,
    isRoot: true,
    config,
  })) as { attempt: number }

  // 同一 (sessionId, turn, type) 必须返回缓存结果，而不是把次数加到 2。
  const second = (await client.request({
    type: 'turn-stopping',
    sessionId: 's',
    turn: 1,
    finishKind: 'stop',
    aborted: false,
    isRoot: true,
    config,
  })) as { attempt: number }

  assert.equal(first.attempt, 1)
  assert.equal(second.attempt, 1)
})

test('协议版本不匹配时拒绝连接', async () => {
  const { socketPath, daemon } = setup()
  cleanups.push(() => {
    daemon.close()
  })
  await waitForSocket(socketPath)

  await assert.rejects(async () => {
    // 用一个明显不兼容的版本号直接走客户端；connectClient 会发当前版本，
    // 因此这里手工构造一次握手。
    const { connect } = await import('node:net')
    const socket = connect(socketPath)
    await new Promise<void>((resolveReady) => socket.once('connect', () => resolveReady()))
    socket.write(`${JSON.stringify({ type: 'hello', protocol: 99, clientId: 'x', pid: 1 })}\n`)
    const reply = await new Promise<string>((resolveReply) => {
      socket.once('data', (chunk: Buffer) => resolveReply(chunk.toString('utf8')))
    })
    socket.destroy()
    assert.match(reply, /"type":"fatal"/)
    throw new Error('protocol mismatch rejected')
  }, /protocol mismatch rejected/)
})

test('socket 权限被收紧到 0600', async () => {
  const { socketPath, daemon } = setup()
  cleanups.push(() => {
    daemon.close()
  })
  await waitForSocket(socketPath)

  // 文件由 bind 创建、权限在 listen 回调里收紧，两者之间隔着一个 tick。
  const { statSync } = await import('node:fs')
  let mode = statSync(socketPath).mode & 0o777
  for (let attempt = 0; attempt < 100 && mode !== 0o600; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    mode = statSync(socketPath).mode & 0o777
  }
  assert.equal(mode, 0o600, 'socket 必须是 0600：它是本机的权限边界')
})

test('最后一个连接断开后，宽限期到点即退出并清理文件', async () => {
  let exited = false
  const home = mkdtempSync(join(tmpdir(), 'tm-daemon-'))
  const socketPath = join(home, 'run', 'target-monitor.sock')
  const pidPath = join(home, 'run', 'target-monitor.pid')
  const daemon = startDaemon({
    socketPath,
    pidPath,
    graceMs: 50,
    onExit: () => {
      exited = true
      daemon.close()
    },
  })
  cleanups.push(() => {
    daemon.close()
  })
  await waitForSocket(socketPath)

  const client = await connectClient({ socketPath })
  client.close()

  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  assert.equal(exited, true, '宽限期结束后必须触发退出')
  assert.equal(existsSync(socketPath), false, 'socket 文件必须被清理')
  assert.equal(existsSync(pidPath), false, 'pid 文件必须被清理')
})
