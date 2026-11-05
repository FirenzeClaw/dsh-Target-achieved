/**
 * 收尾门行为测试：放行、拦截、取消、无上限、阈值提示、不解析文本。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { recordFinish } from '../../src/cause.ts'
import type { TargetMonitorConfig } from '../../src/config.ts'
import { handleTurnStopping, type GateDeps } from '../../src/gate.ts'
import { declare, latchOf } from '../../src/state.ts'

const asAgent = () => ({ id: 'a' }) as unknown as Agent

interface Harness {
  deps: GateDeps
  delivered: { text: string; summary: string }[]
}

function harness(overrides: Partial<TargetMonitorConfig> = {}, root = true): Harness {
  const delivered: { text: string; summary: string }[] = []
  const config: TargetMonitorConfig = {
    enabled: true,
    stallNoticeThreshold: 5,
    reminderThreshold: 3,
    reactionWindowMs: 30_000,
    ...overrides,
  }
  return {
    delivered,
    deps: {
      config: () => config,
      isRoot: () => root,
      deliver: (_agent, text, summary) => {
        delivered.push({ text, summary })
      },
    },
  }
}

function finish(agent: Agent, turn: number, kind: string): void {
  recordFinish(agent, turn, { kind } as FinishReason)
}

test('未声明 + stop → 注入一次提醒并拒绝关闭', () => {
  const agent = asAgent()
  finish(agent, 1, 'stop')
  const h = harness()

  assert.equal(handleTurnStopping(h.deps, agent, 1), true)
  assert.equal(h.delivered.length, 1)
  assert.match(h.delivered[0]!.text, /NOT a user message/)
  assert.equal(latchOf(agent, 1).repairs, 1)
})

test('已声明 done → 放行，零注入', () => {
  const agent = asAgent()
  declare(agent, 1, 'done')
  finish(agent, 1, 'stop')
  const h = harness()

  assert.equal(handleTurnStopping(h.deps, agent, 1), false)
  assert.equal(h.delivered.length, 0)
})

test('已声明 awaiting_user → 放行，零注入', () => {
  const agent = asAgent()
  declare(agent, 1, 'awaiting_user')
  const h = harness()

  assert.equal(handleTurnStopping(h.deps, agent, 1), false)
  assert.equal(h.delivered.length, 0)
})

test('非顶层 agent → 不设门', () => {
  const agent = asAgent()
  finish(agent, 1, 'stop')
  const h = harness({}, false)

  assert.equal(handleTurnStopping(h.deps, agent, 1), false)
  assert.equal(h.delivered.length, 0)
})

test('aborted → 不复活（取消优先）', () => {
  const agent = asAgent()
  finish(agent, 1, 'aborted')
  const h = harness()

  assert.equal(handleTurnStopping(h.deps, agent, 1), false)
  assert.equal(h.delivered.length, 0)
})

test('取消后进入新轮次，门照常生效', () => {
  const agent = asAgent()
  finish(agent, 1, 'aborted')
  const h = harness()
  handleTurnStopping(h.deps, agent, 1)

  finish(agent, 2, 'stop')
  assert.equal(handleTurnStopping(h.deps, agent, 2), true)
  assert.equal(h.delivered.length, 1)
})

test('截断原因选用截断文案', () => {
  const agent = asAgent()
  finish(agent, 1, 'max-tokens')
  const h = harness()

  handleTurnStopping(h.deps, agent, 1)
  assert.match(h.delivered[0]!.text, /were not executed/)
})

test('不设上限：连续 11 次未声明仍然每次都注入', () => {
  const agent = asAgent()
  finish(agent, 1, 'stop')
  const h = harness()

  for (let i = 0; i < 11; i += 1) {
    assert.equal(handleTurnStopping(h.deps, agent, 1), true, `第 ${i + 1} 次应注入`)
  }
  // 每次未声明恰好一条消息；阈值提示合并在第 5 条里，不额外增加条数。
  assert.equal(h.delivered.length, 11)
  assert.equal(latchOf(agent, 1).repairs, 11)
  assert.match(h.delivered[4]!.text, /卡住/)
})

test('阈值提示只在第 N 次出现一次', () => {
  const agent = asAgent()
  finish(agent, 1, 'stop')
  const h = harness()

  for (let i = 1; i <= 8; i += 1) handleTurnStopping(h.deps, agent, 1)

  const stallCount = h.delivered.filter((d) => d.text.includes('卡住')).length
  assert.equal(stallCount, 1, '阈值提示只出现一次')
  assert.match(h.delivered[4]!.text, /卡住/, '第 5 次即提示')
})

test('阈值可配置：设为 2 时第 2 次即提示', () => {
  const agent = asAgent()
  finish(agent, 1, 'stop')
  const h = harness({ stallNoticeThreshold: 2 })

  handleTurnStopping(h.deps, agent, 1)
  handleTurnStopping(h.deps, agent, 1)

  assert.equal(h.delivered.filter((d) => d.text.includes('卡住')).length, 1)
  assert.match(h.delivered[1]!.text, /卡住/, '第 2 次即提示')
})

test('不解析正文：即便文本里有 DONE 字样，未调用工具仍注入', () => {
  const agent = asAgent()
  finish(agent, 1, 'stop')
  const h = harness()

  // 门只看闩锁；这里没有任何声明，因此必然注入。
  assert.equal(handleTurnStopping(h.deps, agent, 1), true)
  assert.equal(h.delivered.length, 1)
})

test('volatile 开关：判定时禁用即不再注入（热生效）', () => {
  const agent = asAgent()
  finish(agent, 1, 'stop')

  let enabled = true
  const delivered: string[] = []
  const deps: GateDeps = {
    config: () => ({ enabled, stallNoticeThreshold: 5, reminderThreshold: 3, reactionWindowMs: 30_000 }),
    isRoot: () => true,
    deliver: (_a, text) => { delivered.push(text) },
  }

  assert.equal(handleTurnStopping(deps, agent, 1), true)
  assert.equal(delivered.length, 1)

  enabled = false
  assert.equal(handleTurnStopping(deps, agent, 1), false, '关闭后必须立刻停止注入')
  assert.equal(delivered.length, 1)
})
