/**
 * 集成测试：关闭初始注入（spec 008 / US1，v0.5 起改为「只停章节」）。
 *
 * `declarationSection` 的语义是「会话开始时要不要自动注入规范」，不是「要不要
 * 声明通道」。关掉它对应的场景是改用 AGENTS.md 承载规范（设置分区会给出可复制的
 * 片段）；此时 `target_status` 工具、收尾门与上游续行都必须照常工作，否则模型仍有
 * 通道、门却不再提醒，等于把用户主动选择的一种配置方式变成功能缺失。
 *
 * 因此本文件验证两件事：
 * 1. 章节确实不再注册（省 token 的收益成立）；
 * 2. 工具、收尾门、上游续行**仍然**工作（能力没有被连带关掉）。
 *
 * 驱动方式与其他集成测试一致：假 ctx 跑真实 `apply`。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
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
      // 必须用真实 LlmError：分类只认它（`error instanceof LlmError`），
      // 拿普通 Error 加个 code 会被判成 non-retryable，续行分支根本走不到。
      listeners.get('agent/error')?.({ agent, turn, error: new LlmError('rate limited', 'RATE_LIMIT') })
    },
  }
}

test('declarationSection=false 时不注册系统提示词章节', () => {
  const f = fakeAgent()
  const h = harness([f.agent], false)

  assert.equal(h.sectionCalls, 0, '关闭后不得注入系统提示词章节——这是该开关唯一的职责')
})

test('declarationSection=false 时 target_status 仍然注册', () => {
  const f = fakeAgent()
  const h = harness([f.agent], false)

  assert.equal(h.toolCalls, 1, '关掉教学不等于关掉通道：工具必须照常可用')
})

test('declarationSection=false 时收尾门照常注入', () => {
  const f = fakeAgent()
  const h = harness([f.agent], false)

  h.turnStopping(f.agent, 1)

  assert.equal(f.nextStep.length, 1, '工具仍在，门就有可满足的条件，应当继续提醒')
})

test('declarationSection=false 时上游续行照常投递', async () => {
  const f = fakeAgent()
  const h = harness([f.agent], false)

  h.error(f.agent, 1)
  // whenIdle 是微任务链，跑完若干微任务再断言。
  for (let i = 0; i < 6; i += 1) await Promise.resolve()

  assert.equal(f.nextStep.length, 1, '续行提醒同样在催促一个仍然可满足的条件')
})

test('declarationSection=true 时章节、工具与门都在', () => {
  const f = fakeAgent()
  const h = harness([f.agent], true)

  assert.equal(h.sectionCalls, 1)
  assert.equal(h.toolCalls, 1)

  h.turnStopping(f.agent, 1)
  assert.equal(f.nextStep.length, 1, '默认配置下门应当注入')
})
