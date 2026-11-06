/**
 * 守护进程状态表的单元测试。
 *
 * 这些用例是「跨进程共享」的语义基准：同一个 sessionId 的状态必须跨连接、
 * 跨轮次地累计，而轮内状态必须随轮次重置。
 */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  declare,
  finish,
  forgetSession,
  IDLE_TTL_MS,
  resetSessions,
  resumeConfirm,
  sessionCount,
  stateOf,
  sweep,
  turnStart,
  turnStopping,
  upstreamError,
} from '../../src/daemon/state.ts'
import type { MonitorConfigSnapshot } from '../../src/ipc/protocol.ts'

const config: MonitorConfigSnapshot = {
  enabled: true,
  stallNoticeThreshold: 5,
  reminderThreshold: 3,
  reactionWindowMs: 30_000,
  resumeOnUpstreamError: true,
  maxResumes: 3,
  declarationSection: true,
}

beforeEach(() => {
  resetSessions()
})

test('轮次开始后状态为 working，计数从零起', () => {
  turnStart('s1', 1, 1_000)
  const state = stateOf('s1', 1, 1_000)
  assert.equal(state.turn.state, 'working')
  assert.equal(state.forgetCount, 0)
  assert.equal(state.turn.repairs, 0)
})

test('轮次变化重置轮内状态，但保留遗忘计数', () => {
  turnStart('s1', 1, 0)
  stateOf('s1', 1, 0).forgetCount = 2
  stateOf('s1', 1, 0).turn.repairs = 4

  turnStart('s1', 2, 10)
  const state = stateOf('s1', 2, 10)
  assert.equal(state.turn.turn, 2)
  assert.equal(state.turn.state, 'working')
  assert.equal(state.turn.repairs, 0)
  assert.equal(state.forgetCount, 2, '遗忘计数必须跨轮累计')
})

test('窗口内声明计入遗忘次数，窗口外不计入', () => {
  turnStart('s1', 1, 0)
  turnStopping({ sessionId: 's1', turn: 1, cause: 'undeclared', aborted: false, isRoot: true, config, now: 1_000 })
  // 注入发生在 1000；20000 时声明，窗口 30 秒内
  const counted = declare('s1', 1, 'done', 20_000, config.reactionWindowMs)
  assert.equal(counted.counted, true)
  assert.equal(counted.forgetCount, 1)

  // 第二轮：注入后 30 秒才声明，不计入
  turnStart('s1', 2, 40_000)
  turnStopping({ sessionId: 's1', turn: 2, cause: 'undeclared', aborted: false, isRoot: true, config, now: 40_000 })
  const late = declare('s1', 2, 'done', 90_000, config.reactionWindowMs)
  assert.equal(late.counted, false)
  assert.equal(late.forgetCount, 1)
})

test('一次注入最多计一次，重复声明不再加', () => {
  turnStart('s1', 1, 0)
  turnStopping({ sessionId: 's1', turn: 1, cause: 'undeclared', aborted: false, isRoot: true, config, now: 0 })
  declare('s1', 1, 'done', 1_000, config.reactionWindowMs)
  const again = declare('s1', 1, 'done', 2_000, config.reactionWindowMs)
  assert.equal(again.counted, false)
  assert.equal(again.forgetCount, 1)
})

test('未声明时注入，次数递增且原因正确', () => {
  turnStart('s1', 1, 0)
  const first = turnStopping({ sessionId: 's1', turn: 1, cause: 'undeclared', aborted: false, isRoot: true, config, now: 0 })
  assert.equal(first.inject, true)
  assert.equal(first.attempt, 1)
  const second = turnStopping({ sessionId: 's1', turn: 1, cause: 'undeclared', aborted: false, isRoot: true, config, now: 1 })
  assert.equal(second.attempt, 2)
})

test('已声明时放行，原因为 declared', () => {
  turnStart('s1', 1, 0)
  declare('s1', 1, 'awaiting_user', 1, config.reactionWindowMs)
  const result = turnStopping({ sessionId: 's1', turn: 1, cause: 'undeclared', aborted: false, isRoot: true, config, now: 2 })
  assert.equal(result.inject, false)
  assert.equal(result.reason, 'declared')
})

test('取消与错误在留痕原因上分开', () => {
  turnStart('s1', 1, 0)
  const aborted = turnStopping({ sessionId: 's1', turn: 1, cause: 'not-applicable', aborted: true, isRoot: true, config, now: 0 })
  assert.equal(aborted.reason, 'aborted')
  const errored = turnStopping({ sessionId: 's1', turn: 1, cause: 'not-applicable', aborted: false, isRoot: true, config, now: 1 })
  assert.equal(errored.reason, 'error')
})

test('declarationSection 关闭不影响收尾门判定', () => {
  // 章节只管系统提示词是否注入；工具与门照常工作。守护进程这一侧若把章节
  // 接进判定，会出现「客户端在提醒、守护进程不提醒」的分裂行为。
  turnStart('s1', 1, 0)
  const result = turnStopping({
    sessionId: 's1',
    turn: 1,
    cause: 'undeclared',
    aborted: false,
    isRoot: true,
    config: { ...config, declarationSection: false },
    now: 0,
  })
  assert.equal(result.inject, true)
  assert.equal(result.reason, 'undeclared')
})

test('不同会话互不影响', () => {
  turnStart('a', 1, 0)
  turnStart('b', 1, 0)
  turnStopping({ sessionId: 'a', turn: 1, cause: 'undeclared', aborted: false, isRoot: true, config, now: 0 })
  declare('a', 1, 'done', 100, config.reactionWindowMs)
  const b = turnStopping({ sessionId: 'b', turn: 1, cause: 'undeclared', aborted: false, isRoot: true, config, now: 100 })
  assert.equal(b.inject, true)
  assert.equal(b.attempt, 1)
})

test('同一轮的上游错误只排队一次', () => {
  turnStart('s1', 3, 0)
  assert.equal(upstreamError({ sessionId: 's1', turn: 3, config, now: 0 }).resume, true)
  assert.equal(upstreamError({ sessionId: 's1', turn: 3, config, now: 1 }).resume, false)
  assert.equal(upstreamError({ sessionId: 's1', turn: 4, config, now: 2 }).resume, true)
})

test('续行达到上限后不再续，正常结束会清零', () => {
  turnStart('s1', 1, 0)
  for (let i = 0; i < 3; i += 1) {
    upstreamError({ sessionId: 's1', turn: i + 1, config, now: i })
    assert.equal(resumeConfirm({ sessionId: 's1', turn: i + 1, config, now: i }).resume, true)
  }
  upstreamError({ sessionId: 's1', turn: 4, config, now: 10 })
  assert.equal(resumeConfirm({ sessionId: 's1', turn: 4, config, now: 10 }).reason, 'capped')

  finish('s1', 4, 'stop', 11)
  upstreamError({ sessionId: 's1', turn: 5, config, now: 12 })
  assert.equal(resumeConfirm({ sessionId: 's1', turn: 5, config, now: 12 }).resume, true)
})

test('maxResumes 为 0 等价于关闭', () => {
  turnStart('s1', 1, 0)
  const disabled = { ...config, maxResumes: 0 }
  assert.equal(upstreamError({ sessionId: 's1', turn: 1, config: disabled, now: 0 }).resume, false)
})

test('闲置回收只删掉过期会话', () => {
  turnStart('old', 1, 0)
  turnStart('fresh', 1, IDLE_TTL_MS)
  const removed = sweep(IDLE_TTL_MS + 1)
  assert.equal(removed, 1)
  assert.equal(sessionCount(), 1)
})

test('dispose 删除会话状态', () => {
  turnStart('s1', 1, 0)
  forgetSession('s1')
  assert.equal(sessionCount(), 0)
})
