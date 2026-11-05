/**
 * 集成测试：关闭初始注入（spec 008 / US1）。
 *
 * 关掉 `declarationSection` 不是"少一段提示词"那么简单：章节、工具、收尾门、
 * 上游续行四者共用同一个前提——模型知道 `target_status` 存在。只关章节而留着门，
 * 门会不断催促一个模型根本没有通道去满足的条件。因此本文件同时验证四件事一起停。
 *
 * 驱动方式与其他集成测试一致：假 ctx 跑真实 `apply`。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../../src/index.ts'

interface FakeAgent {
  agent: Agent
  nextStep: unknown[]
}

function fakeAgent(): FakeAgent {
  const nextStep: unknown[] = []
  const inbox = {
    nextStep,
    nextTurn: [] as unknown[],
    prepend(target: 'next-step' | 'next-turn', message: unknown) {
      const list = target === 'next-step' ? nextStep : (inbox.nextTurn as unknown[])
      list.unshift(message)
    },
  }
  const agent = {
    id: 'root',
    inbox,
    steer(message: unknown) {
      nextStep.push(message)
    },
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  return { agent, nextStep }
}

interface Harness {
  sectionCalls: number
  toolCalls: number
  turnStopping(agent: Agent, turn: number): void
  error(agent: Agent, turn: number): void
}

/** 挂载插件并记录注册面。 */
function harness(roots: Agent[], declarationSection: boolean): Harness {
  const listeners = new Map<string, (payload: unknown) => void>()
  const counts = { section: 0, tool: 0 }

  const ctx = {
    systemPrompt: {
      section() {
        counts.section += 1
        return () => undefined
      },
    },
    tools: {
      register() {
        counts.tool += 1
        return () => undefined
      },
    },
    on(name: string, listener: (payload: unknown) => void) {
      listeners.set(name, listener)
      return () => undefined
    },
    agents: { roots: () => roots },
  } as unknown as Context

  apply(ctx, {
    crossProcess: false,
    enabled: true,
    declarationSection,
    stallNoticeThreshold: 100,
    reminderThreshold: 3,
    reactionWindowMs: 30_000,
  })

  return {
    get sectionCalls() {
      return counts.section
    },
    get toolCalls() {
      return counts.tool
    },
    turnStopping(agent, turn) {
      listeners.get('agent/turn-stopping')?.({ agent, turn, signal: { aborted: false } })
    },
    error(agent, turn) {
      listeners.get('agent/error')?.({
        agent,
        turn,
        error: Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' }),
      })
    },
  }
}

test('declarationSection=false 时不注册章节与工具', () => {
  const f = fakeAgent()
  const h = harness([f.agent], false)

  assert.equal(h.sectionCalls, 0, '关闭后不得注册系统提示词章节')
  assert.equal(h.toolCalls, 0, '关闭后不得注册 target_status')
})

test('declarationSection=false 时收尾门不注入', () => {
  const f = fakeAgent()
  const h = harness([f.agent], false)

  h.turnStopping(f.agent, 1)

  assert.equal(f.nextStep.length, 0, '没有声明通道就不该催促声明')
})

test('declarationSection=false 时上游续行不投递', async () => {
  const f = fakeAgent()
  const h = harness([f.agent], false)

  h.error(f.agent, 1)
  // whenIdle 是微任务链，等它跑完再断言。
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(f.nextStep.length, 0, '续行同样以声明通道存在为前提')
})

test('declarationSection=true 时三者照常注册与注入', () => {
  const f = fakeAgent()
  const h = harness([f.agent], true)

  assert.equal(h.sectionCalls, 1)
  assert.equal(h.toolCalls, 1)

  h.turnStopping(f.agent, 1)
  assert.equal(f.nextStep.length, 1, '默认配置下门应当注入')
})
