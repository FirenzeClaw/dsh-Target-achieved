/**
 * 上游异常续行的集成测试：驱动真实 apply，验证投递时机、文案与计数。
 *
 * 锁定的最易错点：**不能在 `agent/error` 监听器里同步投递**。那一刻轮次仍是
 * `running`，宿主的 `wakeDriver` 不会置 `wakeRequested`（`dsh-agent-loop/lib/index.js:854-860`），
 * 消息只会躺在队列里，等下一次用户输入才被消费——看起来"注入成功"，实际没续行。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { apply } from '../../src/index.ts'
import { repairText } from '../../src/prompt.ts'
import { forgetResume, resumeStateOf } from '../../src/resume.ts'

interface FakeAgent {
  agent: Agent
  steered: { content: { type: string; text?: string }[]; source?: { kind?: string; form?: string } }[]
}

/** 最小 agent 替身：提供 whenIdle 与 steer。 */
function fakeAgent(id = 'root'): FakeAgent {
  const steered: FakeAgent['steered'] = []
  const agent = {
    id,
    inbox: { nextStep: [], nextTurn: [], prepend() {} },
    whenIdle: () => Promise.resolve(),
    steer(message: FakeAgent['steered'][number]) {
      steered.push(message)
    },
  } as unknown as Agent
  return { agent, steered }
}

interface Harness {
  /** 触发一次 agent/error。 */
  error(agent: Agent, turn: number, error: unknown): void
  /** 触发一次 assistant-stream 的 start 帧。 */
  startFrame(agent: Agent, turn: number): void
  /** 触发一次 finish 帧。 */
  finish(agent: Agent, kind: 'stop' | 'tool-calls' | 'max-tokens' | 'error'): void
  /** 清空投递记录。 */
  reset(agent: FakeAgent): void
}

/** 把插件挂在假 ctx 上。 */
function harness(roots: Agent[], config: Record<string, unknown> = {}): Harness {
  const listeners = new Map<string, (payload: unknown) => void>()
  const ctx = {
    systemPrompt: { section: () => () => undefined },
    tools: { register: () => () => undefined },
    on(name: string, listener: (payload: unknown) => void) {
      listeners.set(name, listener)
      return () => undefined
    },
    agents: { roots: () => roots },
  } as unknown as Context

  apply(ctx, {
    enabled: true,
    stallNoticeThreshold: 5,
    reminderThreshold: 3,
    reactionWindowMs: 30_000,
    resumeOnUpstreamError: true,
    maxResumes: 3,
    ...config,
  })

  return {
    error(agent, turn, error) {
      const listener = listeners.get('agent/error')
      assert.ok(listener, 'agent/error 监听器必须已注册')
      listener({ agent, turn, step: 1, error })
    },
    startFrame(agent, turn) {
      listeners.get('agent/assistant-stream')?.({ agent, frame: { type: 'start', turn, step: 0 } })
    },
    finish(agent, kind) {
      listeners.get('agent/assistant-stream')?.({
        agent,
        frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind } } },
      })
    },
    reset(f) {
      f.steered.length = 0
    },
  }
}

/** 让 whenIdle 的 then 回调跑完。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

test('US1：可重试错误后自动投递一条自救提醒，文案复用收尾门的正文', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.error(f.agent, 3, new LlmError('rate limited', 'RATE_LIMIT'))
  assert.equal(f.steered.length, 0, '不得在 running 阶段同步投递')

  await flush()
  assert.equal(f.steered.length, 1, 'idle 之后必须投递一次')

  const message = f.steered[0]
  assert.ok(message)
  const text = message.content.map((block) => block.text ?? '').join('')
  assert.equal(text, repairText('undeclared', 1), '必须复用既有文案，不新增副本')
  assert.equal(message.source?.kind, 'target-monitor', '来源必须可归属，绝不能是 user')
  assert.equal(message.source?.form, 'notice')
})

test('US1：不可重试错误不投递', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.error(f.agent, 3, new LlmError('bad key', 'AUTH'))
  await flush()
  assert.equal(f.steered.length, 0)
})

test('US1：非 LlmError 不投递', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.error(f.agent, 3, new Error('ECONNRESET'))
  await flush()
  assert.equal(f.steered.length, 0)
})

test('US1：同一轮的多次 agent/error 只投递一次', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.error(f.agent, 3, new LlmError('rate limited', 'RATE_LIMIT'))
  h.error(f.agent, 3, new LlmError('rate limited', 'RATE_LIMIT'))
  await flush()
  assert.equal(f.steered.length, 1, '同轮去重必须在决定投递前生效')
})

test('US1：正常 finish 帧后连续计数清零', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.error(f.agent, 3, new LlmError('rate limited', 'RATE_LIMIT'))
  await flush()
  assert.equal(resumeStateOf(f.agent)?.consecutive, 1)

  h.startFrame(f.agent, 4)
  h.finish(f.agent, 'stop')
  assert.equal(resumeStateOf(f.agent)?.consecutive, 0, '上游通了就应当清零')
})

test('US1：error / aborted 帧不清零', async () => {
  const f = fakeAgent()
  const h = harness([f.agent])

  h.error(f.agent, 3, new LlmError('rate limited', 'RATE_LIMIT'))
  await flush()

  h.startFrame(f.agent, 4)
  h.finish(f.agent, 'error')
  assert.equal(resumeStateOf(f.agent)?.consecutive, 1, '失败不能清零，否则永远攒不到上限')

  forgetResume(f.agent)
})
