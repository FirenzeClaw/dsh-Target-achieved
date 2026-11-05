/**
 * 结束原因归一化测试。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { classify, finishOf, forgetCause, recordFinish } from '../../src/cause.ts'

const asAgent = () => ({ id: 'a' }) as unknown as Agent

test('max-tokens 归一化为 truncated', () => {
  assert.equal(classify({ kind: 'max-tokens' } as FinishReason), 'truncated')
})

test('stop 与 tool-calls 归一化为 undeclared', () => {
  assert.equal(classify({ kind: 'stop' } as FinishReason), 'undeclared')
  assert.equal(classify({ kind: 'tool-calls' } as FinishReason), 'undeclared')
})

test('aborted / error 归一化为不适用（不该注入）', () => {
  assert.equal(classify({ kind: 'aborted' } as unknown as FinishReason), 'not-applicable')
  assert.equal(classify({ kind: 'error' } as unknown as FinishReason), 'not-applicable')
})

test('未记录时视为 undeclared', () => {
  assert.equal(classify(undefined), 'undeclared')
})

test('跨轮次的旧 finish 不被采信', () => {
  const agent = asAgent()
  recordFinish(agent, 1, { kind: 'max-tokens' } as FinishReason)
  assert.equal(finishOf(agent, 1)?.kind, 'max-tokens')
  assert.equal(finishOf(agent, 2), undefined)
})

test('forgetCause 清理记录', () => {
  const agent = asAgent()
  recordFinish(agent, 1, { kind: 'stop' } as FinishReason)
  forgetCause(agent)
  assert.equal(finishOf(agent, 1), undefined)
})
