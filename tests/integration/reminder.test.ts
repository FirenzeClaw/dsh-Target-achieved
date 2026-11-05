/**
 * 集成测试：声明规范复述（spec 005）。
 *
 * 为什么放在集成层——复述的计数依赖"注入 → 工具被调用"这条完整链路：
 * 门负责登记注入，`target_status` 负责登记声明。只测 `forget.ts` 或只测门，
 * 都无法证明两者接上了（初版单测就踩过这个坑：直接调 `state.declare` 绕过了工具回调）。
 *
 * 本文件通过假 ctx 驱动真实 `apply`。去掉 `src/index.ts` 里传给
 * `registerTargetStatus` 的 `onDeclared`，本文件的复述用例必须失败。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../../src/index.ts'
import { REMINDER_TEXT } from '../../src/prompt.ts'

interface FakeAgent {
  agent: Agent
  nextStep: unknown[]
}

/** 最小 agent 替身：只提供门与投递需要的面。 */
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
  } as unknown as Agent

  return { agent, nextStep }
}

interface Harness {
  startFrame(agent: Agent, turn: number): void
  turnStopping(agent: Agent, turn: number): void
  declare(agent: Agent, state: 'done' | 'awaiting_user'): Promise<{ state: string }>
}

/** 把插件挂在假 ctx 上，收集事件监听器与注册的工具。 */
function harness(roots: Agent[], options: { reminderThreshold?: number } = {}): Harness {
  const listeners = new Map<string, (payload: unknown) => void>()
  let tool: { execute: (args: unknown, exec: { agent?: Agent }) => Promise<unknown> } | undefined

  const ctx = {
    systemPrompt: {
      section() {
        return () => undefined
      },
    },
    tools: {
      register(definition: unknown) {
        tool = definition as typeof tool
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
    enabled: true,
    stallNoticeThreshold: 100,
    reminderThreshold: options.reminderThreshold ?? 3,
    reactionWindowMs: 30_000,
  })

  return {
    startFrame(agent, turn) {
      const listener = listeners.get('agent/assistant-stream')
      assert.ok(listener, 'assistant-stream 监听器必须已注册')
      listener({ agent, frame: { type: 'start', turn, step: 0 } })
    },
    turnStopping(agent, turn) {
      const listener = listeners.get('agent/turn-stopping')
      assert.ok(listener, 'turn-stopping 监听器必须已注册')
      listener({ agent, turn, signal: { aborted: false } })
    },
    async declare(agent, state) {
      assert.ok(tool, 'target_status 必须已注册')
      return (await tool.execute({ state }, { agent })) as { state: string }
    },
  }
}

/** 取一条提醒消息的正文。 */
function textOf(message: unknown): string {
  const content = (message as { content?: { type: string; text?: string }[] }).content ?? []
  return content.map((block) => block.text ?? '').join('')
}

/** 走完"注入一次 → 窗口内声明一次"的遗忘回合。 */
async function forgetOnce(h: Harness, f: FakeAgent, turn: number): Promise<void> {
  h.startFrame(f.agent, turn)
  h.turnStopping(f.agent, turn)
  await h.declare(f.agent, 'done')
}

const REMINDER_HEADING = 'Reminder — the turn-closing rule'

/**
 * 取最新一条提醒的正文。
 *
 * 注意读取位置：队列非空时门走 `inbox.prepend`（FR-017 队首优先），新消息插在
 * 队首，因此最新一条在 `nextStep[0]` 而不是末位。读取末位会一直读到第 1 条，
 * 让"没有复述"永远成立——本文件的初版就踩过这个坑。
 */
function latestText(f: FakeAgent): string {
  const newest = f.nextStep[0]
  assert.ok(newest !== undefined, '应当至少有一条提醒')
  return textOf(newest)
}

test('累计三次遗忘后，第四次注入带规范复述', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  for (let turn = 1; turn <= 3; turn += 1) await forgetOnce(h, f, turn)

  // 前三次都是"普通提醒"，不含复述。
  assert.equal(
    f.nextStep.map(textOf).filter((text) => text.includes(REMINDER_HEADING)).length,
    0,
    '未达阈值时不得复述',
  )

  h.startFrame(f.agent, 4)
  h.turnStopping(f.agent, 4)

  const last = latestText(f)
  assert.match(last, /Reminder — the turn-closing rule/)
  assert.match(last, /call target_status\("done"\) FIRST, then report/)
  assert.match(last, /call target_status\("awaiting_user"\) FIRST, then ask/)
})

test('复述发出后计数清零，紧接着的注入不再复述', async () => {
  const f = fakeAgent()
  const h = harness([f.agent], { reminderThreshold: 2 })

  await forgetOnce(h, f, 1)
  await forgetOnce(h, f, 2)

  h.startFrame(f.agent, 3)
  h.turnStopping(f.agent, 3)
  assert.match(latestText(f), /Reminder — the turn-closing rule/)

  h.turnStopping(f.agent, 3)
  assert.doesNotMatch(latestText(f), /Reminder — the turn-closing rule/, '已清零，不应连续复述')
})

test('真中断不推进计数：注入后没有声明，计数保持且不清零', async () => {
  const f = fakeAgent()
  const h = harness([f.agent], { reminderThreshold: 2 })

  // 第一次遗忘：注入后立刻声明 → 计 1 次
  await forgetOnce(h, f, 1)

  // 第二次注入后没有声明（真中断），直接进入第三次注入
  h.startFrame(f.agent, 2)
  h.turnStopping(f.agent, 2)
  h.startFrame(f.agent, 3)
  h.turnStopping(f.agent, 3)

  // 计数仍为 1，未达阈值 2 → 这两次都不该带复述
  // 第 2、3 次注入都不该带复述：计数停在 1，未达阈值 2。
  for (const message of f.nextStep) {
    assert.doesNotMatch(textOf(message), /Reminder — the turn-closing rule/)
  }

  // 再遗忘两次即达阈值：证明真中断既没清零也没误计
  await forgetOnce(h, f, 4)
  h.startFrame(f.agent, 5)
  h.turnStopping(f.agent, 5)
  assert.match(latestText(f), /Reminder — the turn-closing rule/)
})

test('声明被拒绝时不推进计数', async () => {
  const f = fakeAgent()
  const h = harness([f.agent], { reminderThreshold: 1 })

  // 注入后不声明，而是触发一次必然失败的调用（未观察轮次）
  const { agent: other } = fakeAgent()
  h.turnStopping(f.agent, 1)
  await assert.rejects(() => h.declare(other, 'done'), /TARGET_STATUS_NOT_ROOT|TARGET_STATUS_NO_TURN/)

  h.turnStopping(f.agent, 1)
  assert.doesNotMatch(latestText(f), /Reminder — the turn-closing rule/, '失败的声明不得计入遗忘次数')
})

test('复述文案是纯常量，不含轮次或计数', async () => {
  const f = fakeAgent()
  const h = harness([f.agent], { reminderThreshold: 1 })

  await forgetOnce(h, f, 1)
  h.startFrame(f.agent, 2)
  h.turnStopping(f.agent, 2)

  const text = latestText(f)
  // 复述段必须与常量逐字相同：任何拼接（轮次、次数、阈值）都会让文案随运行时状态
  // 变化，既没有信息价值，又扩大了提示注入面（宪法原则 III）。
  assert.ok(text.endsWith(REMINDER_TEXT), '复述段必须是常量原文，不得拼接运行时数据')
})
