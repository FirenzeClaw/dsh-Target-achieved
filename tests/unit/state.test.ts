/**
 * 状态机测试：轮次切换即重置、声明覆盖、计数与清理。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bumpRepair, declare, forget, isDeclared, latchOf, markNoticeShown } from '../../src/state.ts'

/** 测试替身：状态表以对象身份为键，不需要真实 Agent。 */
const asAgent = () => ({ id: 'a' }) as unknown as Agent

test('新轮次默认 working，且计数归零', () => {
  const agent = asAgent()
  const latch = latchOf(agent, 1)
  assert.equal(latch.state, 'working')
  assert.equal(latch.repairs, 0)
  assert.equal(latch.noticeShown, false)
  assert.equal(isDeclared(agent, 1), false)
})

test('declare 后状态改变，且 done 被判定为已声明', () => {
  const agent = asAgent()
  declare(agent, 1, 'done')
  assert.equal(latchOf(agent, 1).state, 'done')
  assert.equal(isDeclared(agent, 1), true)
})

test('同一轮内后声明覆盖前声明', () => {
  const agent = asAgent()
  declare(agent, 1, 'done')
  declare(agent, 1, 'awaiting_user')
  assert.equal(latchOf(agent, 1).state, 'awaiting_user')
})

test('轮次号变化自动回到 working，计数与通知标记一并重置', () => {
  const agent = asAgent()
  declare(agent, 1, 'done')
  bumpRepair(agent, 1)
  markNoticeShown(agent, 1)

  const next = latchOf(agent, 2)
  assert.equal(next.state, 'working')
  assert.equal(next.repairs, 0)
  assert.equal(next.noticeShown, false)
})

test('repairs 单调递增', () => {
  const agent = asAgent()
  assert.equal(bumpRepair(agent, 1), 1)
  assert.equal(bumpRepair(agent, 1), 2)
  assert.equal(bumpRepair(agent, 1), 3)
})

test('forget 后状态清空', () => {
  const agent = asAgent()
  declare(agent, 1, 'done')
  forget(agent)
  assert.equal(latchOf(agent, 1).state, 'working')
})
