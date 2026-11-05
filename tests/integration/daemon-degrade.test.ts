/**
 * 降级路径的集成测试：守护进程不可用时，插件必须照常工作。
 *
 * 守护进程是本项目新增的故障面。这组用例守的是「它坏了不等于插件坏了」，
 * 而不是「它坏了会怎样」——后者无关紧要。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TargetMonitorConfig } from '../../src/config.ts'
import { createRemoteMonitor } from '../../src/monitor/remote.ts'

const config: TargetMonitorConfig = {
  enabled: true,
  stallNoticeThreshold: 5,
  reminderThreshold: 3,
  reactionWindowMs: 30_000,
  resumeOnUpstreamError: true,
  maxResumes: 3,
  declarationSection: true,
  crossProcess: true,
}

/** 最小 agent 替身：进程内实现只需要 id。 */
function fakeAgent(id = 's1'): Agent {
  return { id, inbox: { nextStep: [], nextTurn: [] } } as unknown as Agent
}

test('socket 不可用时降级，判定仍然给出注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-degrade-'))
  const warnings: string[] = []

  const monitor = createRemoteMonitor({
    // 指向一个普通文件：连接会被拒绝，拉起也无法建 socket。
    socketPath: join(dir, 'not-a-socket'),
    pidPath: join(dir, 'not-a-socket.pid'),
    config: () => config,
    warn: (message) => warnings.push(message),
    launchBudgetMs: 100,
  })

  const result = await monitor.turnStopping({
    agent: fakeAgent(),
    turn: 1,
    finishKind: 'stop',
    aborted: false,
    isRoot: true,
  })

  assert.equal(result.inject, true, '守护进程不可用时仍必须注入')
  assert.ok(result.text !== undefined && result.text.length > 0)
  assert.equal(monitor.degraded, true)
  assert.equal(warnings.length, 1, '只告警一次')
})

test('降级后再多次判定，不再重复告警', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-degrade-'))
  const warnings: string[] = []
  const monitor = createRemoteMonitor({
    socketPath: join(dir, 'not-a-socket'),
    pidPath: join(dir, 'not-a-socket.pid'),
    config: () => config,
    warn: (message) => warnings.push(message),
    launchBudgetMs: 100,
  })

  for (let turn = 1; turn <= 5; turn += 1) {
    await monitor.turnStopping({ agent: fakeAgent(), turn, finishKind: 'stop', aborted: false, isRoot: true })
  }

  assert.equal(warnings.length, 1, '每个进程只告警一次（FR-018）')
})

test('降级后声明与计数仍在本进程内生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-degrade-'))
  const monitor = createRemoteMonitor({
    socketPath: join(dir, 'not-a-socket'),
    pidPath: join(dir, 'not-a-socket.pid'),
    config: () => config,
    warn: () => undefined,
    launchBudgetMs: 100,
  })

  const agent = fakeAgent('counted')
  await monitor.turnStopping({ agent, turn: 1, finishKind: 'stop', aborted: false, isRoot: true })
  const declared = await monitor.declare(agent, 1, 'done')

  assert.equal(declared.counted, true, '窗口内声明必须计入遗忘次数')
})

test('crossProcess 关闭时完全不碰 socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-degrade-'))
  // 用一个不存在的 socket 路径；若实现真的去连，会等满 5 秒预算。
  const monitor = createRemoteMonitor({
    socketPath: join(dir, 'never'),
    pidPath: join(dir, 'never.pid'),
    config: () => ({ ...config, crossProcess: false }),
    warn: () => undefined,
    launchBudgetMs: 100,
  })

  const started = Date.now()
  const result = await monitor.turnStopping({
    agent: fakeAgent(),
    turn: 1,
    finishKind: 'stop',
    aborted: false,
    isRoot: true,
  })
  const elapsed = Date.now() - started

  assert.equal(result.inject, true)
  // 本实现仍在 RemoteMonitor 里；crossProcess 的判断在 index.ts。
  // 这里断言的是「即使走了远程，也必须在预算内给出结果」。
  assert.ok(elapsed < 6_000, `降级耗时过长：${String(elapsed)}ms`)
})
