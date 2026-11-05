/**
 * 回归测试：轮次键对齐（spec 002）。
 *
 * 锁定的缺陷：`target_status` 的轮次号曾取自只在 `agent/turn-stopping` 写入的 WeakMap，
 * 而那是轮次**结束**时刻。于是一轮里第一次声明会写到上一轮的键上，收尾判定读不到，
 * 仍然注入——每轮必被多催一次，且只有被催过之后的第二次声明才生效。
 *
 * 本文件通过假 ctx 直接驱动 `apply`，覆盖"事件接线 → 工具 → 收尾判定"整条链路，
 * 而不只是单独测某个函数。去掉 `src/index.ts` 里 start 帧的写入，本文件必须失败。
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
  /** 触发一次 assistant-stream 的 start 帧。 */
  startFrame(agent: Agent, turn: number): void
  /** 触发一次收尾判定。 */
  turnStopping(agent: Agent, turn: number): void
  /** 已注册的系统提示词章节。 */
  sections: { name: string; order: number }[]
  /** 调用 target_status 的 execute。 */
  declare(agent: Agent, state: 'done' | 'awaiting_user'): Promise<{ state: string }>
}

/** 把插件挂在假 ctx 上，收集事件监听器与注册的工具。 */
function harness(roots: Agent[]): Harness {
  const listeners = new Map<string, (payload: unknown) => void>()
  let tool: { execute: (args: unknown, exec: { agent?: Agent }) => Promise<unknown> } | undefined
  const sections: { name: string; order: number }[] = []

  const ctx = {
    systemPrompt: {
      section(section: { name: string; order: number }) {
        sections.push({ name: section.name, order: section.order })
        return () => undefined
      },
    },
    tools: {
      register(definition: unknown) {
        tool = definition as Harness extends never ? never : typeof tool
        return () => undefined
      },
    },
    on(name: string, listener: (payload: unknown) => void) {
      listeners.set(name, listener)
      return () => undefined
    },
    agents: { roots: () => roots },
  } as unknown as Context

  // 集成测试固定走进程内实现：这里验的是事件接线与文案，不是 IPC。
  apply(ctx, { enabled: true, stallNoticeThreshold: 5, reminderThreshold: 3, reactionWindowMs: 30_000, crossProcess: false })

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
    sections,
  }
}

test('US2：声明不再向模型暴露轮次，但内部仍落在本轮', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.startFrame(f.agent, 7)

  const result = await h.declare(f.agent, 'done')
  assert.equal(result.state, 'done')
  // 轮次只用于内部对齐：模型既不需要也不该依赖它。
  assert.equal('turn' in result, false, '返回值不得包含 turn 字段')
  // 内部确实落到了第 7 轮——由收尾判定读到声明来间接证明。
  h.turnStopping(f.agent, 7)
  assert.equal(f.nextStep.length, 0, '声明必须落在本轮，收尾时才读得到')
})

test('US1：轮次内声明 done 后收尾 → 不注入', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.startFrame(f.agent, 7)
  await h.declare(f.agent, 'done')
  h.turnStopping(f.agent, 7)

  assert.equal(f.nextStep.length, 0, '已声明完成就不该再收到自救提醒')
})

test('US1：轮次内声明 awaiting_user 后收尾 → 不注入', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.startFrame(f.agent, 7)
  await h.declare(f.agent, 'awaiting_user')
  h.turnStopping(f.agent, 7)

  assert.equal(f.nextStep.length, 0, '声明等待用户时不得催促')
})

test('US1 反向：未声明就收尾 → 仍然注入（修复不能把门关死）', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.startFrame(f.agent, 7)
  h.turnStopping(f.agent, 7)

  assert.equal(f.nextStep.length, 1, '未声明时门必须照常注入')
})

test('US2：上一轮的声明不得被新一轮继承', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.startFrame(f.agent, 7)
  await h.declare(f.agent, 'done')

  // 进入新一轮：新的 start 帧把轮次推到 8，上一轮的 done 不再可见。
  h.startFrame(f.agent, 8)
  h.turnStopping(f.agent, 8)

  assert.equal(f.nextStep.length, 1, '新一轮未声明时应当注入')
})

test('US2：尚未观察到任何轮次时调用声明 → 显式报错而不是写入哨兵键', async () => {
  const { agent } = fakeAgent()
  const h = harness([agent])

  await assert.rejects(
    () => h.declare(agent, 'done'),
    /TARGET_STATUS_NO_TURN/,
    '无轮次可归属时必须拒绝，而不是把声明写到 0 号轮次',
  )
})

test('规范章节不得与宿主 FILE_REFERENCE 撞号（900）', () => {
  const { agent } = fakeAgent()
  const h = harness([agent])

  const section = h.sections.find((item) => item.name === 'tool:target-monitor')
  assert.ok(section, '声明协议章节必须已注册')
  // 900 是宿主 FILE_REFERENCE 的序号；撞号会让本节被排进 AGENTS.md 正文中间。
  assert.notEqual(section.order, 900, '不得占用宿主的 FILE_REFERENCE 序号')
  assert.ok(section.order >= 2000 && section.order < 2600, '应落在 goal 段之后、workflow 段之前')
})
