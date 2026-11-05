/**
 * 续行判定测试：错误分类、连续计数、前置条件。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  RETRYABLE_CODES,
  claimResumeTurn,
  classifyUpstreamError,
  forgetResume,
  noteResume,
  resetResume,
  resumeStateOf,
  shouldResume,
} from '../../src/resume.ts'

const asAgent = (id = 'root') => ({ id }) as unknown as Agent

test('可重试码集合与宿主默认白名单逐项一致', () => {
  // 宿主：dsh-llm/lib/types/retry-policy.js:16-22 的 DEFAULT_RETRYABLE_CODES。
  assert.deepEqual([...RETRYABLE_CODES].sort(), [
    'EMPTY_RESPONSE',
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
  ])
})

test('5 个可重试码全部判为 retryable', () => {
  for (const code of RETRYABLE_CODES) {
    assert.equal(classifyUpstreamError(new LlmError('boom', code)), 'retryable', code)
  }
})

test('不可重试码逐个判为 non-retryable', () => {
  for (const code of ['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'UNKNOWN']) {
    assert.equal(classifyUpstreamError(new LlmError('boom', code)), 'non-retryable', code)
  }
})

test('非 LlmError 一律 non-retryable，即使是网络类错误信息', () => {
  // 不解析 message 是刻意的：文本不可靠，且解析文本会把错误信息变成分类依据。
  assert.equal(classifyUpstreamError(new Error('ECONNRESET socket hang up')), 'non-retryable')
  assert.equal(classifyUpstreamError(new AggregateError([new Error('x')], 'agg')), 'non-retryable')
  assert.equal(classifyUpstreamError(undefined), 'non-retryable')
  assert.equal(classifyUpstreamError('RATE_LIMIT'), 'non-retryable')
})

test('同一轮只能占用一次续行机会，跨轮可以继续占用', () => {
  const agent = asAgent('a1')
  forgetResume(agent)
  assert.equal(claimResumeTurn(agent, 7), true)
  assert.equal(claimResumeTurn(agent, 7), false, '同一轮不得重复占用')
  assert.equal(claimResumeTurn(agent, 8), true)
})

test('计数只在真正投递后加一', () => {
  const agent = asAgent('a5')
  forgetResume(agent)
  claimResumeTurn(agent, 1)
  assert.equal(resumeStateOf(agent)?.consecutive, 0, '仅占用不计数')
  noteResume(agent)
  assert.equal(resumeStateOf(agent)?.consecutive, 1)
  claimResumeTurn(agent, 2)
  noteResume(agent)
  assert.equal(resumeStateOf(agent)?.consecutive, 2)
})

test('resetResume 归零但保留轮次记录，forgetResume 整体删除', () => {
  const agent = asAgent('a2')
  claimResumeTurn(agent, 3)
  noteResume(agent)
  resetResume(agent)
  assert.equal(resumeStateOf(agent)?.consecutive, 0)

  forgetResume(agent)
  assert.equal(resumeStateOf(agent), undefined)
})

test('计数按 agent 隔离，互不影响', () => {
  const a = asAgent('a3')
  const b = asAgent('a4')
  claimResumeTurn(a, 1)
  noteResume(a)
  claimResumeTurn(a, 2)
  noteResume(a)
  assert.equal(resumeStateOf(a)?.consecutive, 2)
  assert.equal(resumeStateOf(b), undefined)
})

test('shouldResume：六项前置条件逐项为假时拒绝，并给出原因', () => {
  const base = {
    enabled: true,
    resumeOnUpstreamError: true,
    maxResumes: 3,
    consecutive: 0,
    isRoot: true,
    isDisposed: false,
    sameTurn: false,
  }
  const cases: { patch: Partial<typeof base>; reason: string }[] = [
    { patch: { enabled: false }, reason: 'upstream-skipped' },
    { patch: { resumeOnUpstreamError: false }, reason: 'upstream-skipped' },
    { patch: { isRoot: false }, reason: 'upstream-skipped' },
    { patch: { sameTurn: true }, reason: 'upstream-skipped' },
    { patch: { isDisposed: true }, reason: 'upstream-skipped' },
    { patch: { consecutive: 3 }, reason: 'upstream-capped' },
  ]

  assert.deepEqual(shouldResume(base), { resume: true })
  for (const { patch, reason } of cases) {
    assert.deepEqual(shouldResume({ ...base, ...patch }), { resume: false, reason }, JSON.stringify(patch))
  }
})

test('shouldResume：maxResumes 为 0 时等价于关闭', () => {
  const decision = shouldResume({
    enabled: true,
    resumeOnUpstreamError: true,
    maxResumes: 0,
    consecutive: 0,
    isRoot: true,
    isDisposed: false,
    sameTurn: false,
  })
  assert.deepEqual(decision, { resume: false, reason: 'upstream-capped' })
})
