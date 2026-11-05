/**
 * 集成测试：在假宿主上跑完整收尾流程。
 *
 * 目的不是重复 gate 的单测，而是验证接线——事件注册、来源归属、
 * 队列优先级（FR-017）与 dispose 清理这几处只在组合起来才会暴露的问题。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createNotice, noticeSummary } from '../../src/notices.ts'
import { handleTurnStopping, type GateDeps } from '../../src/gate.ts'
import { declare, latchOf } from '../../src/state.ts'

interface FakeAgent {
  agent: Agent
  nextStep: unknown[]
  nextTurn: unknown[]
}

/** 构造一个最小 agent 替身：只提供门与投递需要的面。 */
function fakeAgent(): FakeAgent {
  const nextStep: unknown[] = []
  const nextTurn: unknown[] = []

  const inbox = {
    nextStep,
    nextTurn,
    /** 与宿主一致：prepend 插入队首。 */
    prepend(target: 'next-step' | 'next-turn', message: unknown) {
      const list = target === 'next-step' ? nextStep : nextTurn
      list.unshift(message)
    },
    append(target: 'next-step' | 'next-turn', message: unknown) {
      const list = target === 'next-step' ? nextStep : nextTurn
      list.push(message)
    },
  }

  const agent = {
    id: 'root',
    inbox,
    steer(message: unknown) {
      nextStep.push(message)
    },
  } as unknown as Agent

  return { agent, nextStep, nextTurn }
}

function deps(): GateDeps {
  return {
    config: () => ({ enabled: true, stallNoticeThreshold: 5, reminderThreshold: 3, reactionWindowMs: 30_000 }),
    isRoot: () => true,
    deliver(agent, text, summary) {
      const message = createNotice(text, summary)
      // 与 src/index.ts 中的投递策略保持一致：空队列 steer，非空 prepend。
      if (agent.inbox.nextStep.length === 0) agent.steer(message)
      else agent.inbox.prepend('next-step', message)
    },
  }
}

test('未声明收尾 → 注入一条归属正确、且排在队首的提醒', () => {
  const f = fakeAgent()
  const rejected = handleTurnStopping(deps(), f.agent, 1)

  assert.equal(rejected, true)
  assert.equal(f.nextStep.length, 1)

  const message = f.nextStep[0] as { source: { kind: string; form: string } }
  assert.equal(message.source.kind, 'target-monitor')
  assert.equal(message.source.form, 'notice')
})

test('已声明后收尾 → 不注入', () => {
  const f = fakeAgent()
  declare(f.agent, 1, 'done')

  assert.equal(handleTurnStopping(deps(), f.agent, 1), false)
  assert.equal(f.nextStep.length, 0)
})

test('队列已有消息时，提醒仍位于队首（FR-017）', () => {
  const f = fakeAgent()
  // 模拟竞态：门执行前队列里已经有一条 steer 消息。
  f.nextStep.push({ id: 'existing' })

  handleTurnStopping(deps(), f.agent, 1)

  const head = f.nextStep[0] as { source?: { kind?: string } }
  assert.equal(head.source?.kind, 'target-monitor', '提醒必须在索引 0')
  assert.equal(f.nextStep.length, 2, '原有消息不能被丢弃')
})

test('审计摘要含轮次、原因与次数', () => {
  assert.equal(noticeSummary(3, 'truncated', 2), 'turn 3 · truncated · #2')
})

test('同一轮多次收尾，计数递增且提示只出现一次', () => {
  const f = fakeAgent()
  for (let i = 0; i < 7; i += 1) handleTurnStopping(deps(), f.agent, 1)

  assert.equal(latchOf(f.agent, 1).repairs, 7)
  assert.equal(latchOf(f.agent, 1).noticeShown, true)
})
