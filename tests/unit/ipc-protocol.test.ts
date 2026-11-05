/**
 * 协议层单元测试：编解码、长度上限、字段校验。
 *
 * 这些用例守的是「守护进程收到的每一行都不可信」这个前提——校验漏一个字段，
 * 后面的状态表就可能拿到 `turn: "1"` 之类的值。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeMessage,
  encodeMessage,
  isRequest,
  MAX_LINE_BYTES,
  normalizeConfig,
  PROTOCOL_VERSION,
} from '../../src/ipc/protocol.ts'

const config = {
  enabled: true,
  stallNoticeThreshold: 5,
  reminderThreshold: 3,
  reactionWindowMs: 30_000,
  resumeOnUpstreamError: true,
  maxResumes: 3,
  declarationSection: true,
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'turn-stopping',
    requestId: 'c1:1',
    sessionId: 's1',
    turn: 1,
    config,
    aborted: false,
    isRoot: true,
    ...overrides,
  }
}

test('编码结果以换行结尾且可原样解码', () => {
  const line = encodeMessage({ type: 'bye' })
  assert.ok(line.endsWith('\n'))
  const decoded = decodeMessage(line.trimEnd())
  assert.equal(decoded.ok, true)
})

test('编码不会因为正文里的换行而产生多行', () => {
  const line = encodeMessage({ type: 'fatal', reason: 'a\nb' })
  assert.equal(line.trimEnd().split('\n').length, 1)
})

test('非 JSON 被拒绝', () => {
  const decoded = decodeMessage('{not json')
  assert.equal(decoded.ok, false)
  if (!decoded.ok) assert.equal(decoded.code, 'E_BAD_REQUEST')
})

test('超过 64 KiB 的行被拒绝为 E_OVERSIZE', () => {
  const decoded = decodeMessage('x'.repeat(MAX_LINE_BYTES + 1))
  assert.equal(decoded.ok, false)
  if (!decoded.ok) assert.equal(decoded.code, 'E_OVERSIZE')
})

test('未知类型被拒绝', () => {
  const decoded = decodeMessage(JSON.stringify({ type: 'nope', requestId: 'c1:1', sessionId: 's', turn: 0 }))
  assert.equal(decoded.ok, false)
  if (!decoded.ok) assert.match(decoded.message, /unknown type/)
})

test('turn 必须是非负整数', () => {
  for (const turn of [-1, 1.5, '1', null]) {
    const decoded = decodeMessage(JSON.stringify(request({ turn })))
    assert.equal(decoded.ok, false, `应拒绝 turn=${String(turn)}`)
  }
})

test('sessionId 必须非空且不超过 128 字符', () => {
  assert.equal(decodeMessage(JSON.stringify(request({ sessionId: '' }))).ok, false)
  assert.equal(decodeMessage(JSON.stringify(request({ sessionId: 'x'.repeat(129) }))).ok, false)
  assert.equal(decodeMessage(JSON.stringify(request({ sessionId: 'x'.repeat(128) }))).ok, true)
})

test('declare 必须带合法的 state', () => {
  const base = request({ type: 'declare' })
  assert.equal(decodeMessage(JSON.stringify(base)).ok, false)
  assert.equal(decodeMessage(JSON.stringify({ ...base, state: 'done' })).ok, true)
  assert.equal(decodeMessage(JSON.stringify({ ...base, state: 'working' })).ok, false)
})

test('finish 必须带合法的 finishKind', () => {
  const base = request({ type: 'finish' })
  assert.equal(decodeMessage(JSON.stringify(base)).ok, false)
  assert.equal(decodeMessage(JSON.stringify({ ...base, finishKind: 'stop' })).ok, true)
  assert.equal(decodeMessage(JSON.stringify({ ...base, finishKind: 'weird' })).ok, false)
})

test('turn-stopping 必须带 aborted 与 isRoot', () => {
  assert.equal(decodeMessage(JSON.stringify(request({ aborted: undefined }))).ok, false)
  assert.equal(decodeMessage(JSON.stringify(request({ isRoot: undefined }))).ok, false)
})

test('握手与断开这类非请求消息放行，且不被当成请求', () => {
  const hello = decodeMessage(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: 'c1', pid: 1 }))
  assert.equal(hello.ok, true)
  if (hello.ok && !isRequest(hello.value)) assert.equal(hello.value.type, 'hello')
  const bye = decodeMessage(JSON.stringify({ type: 'bye' }))
  assert.equal(bye.ok, true)
})

test('配置快照缺字段时按默认值补齐，不整体拒绝', () => {
  const decoded = decodeMessage(JSON.stringify(request({ config: { enabled: false } })))
  assert.equal(decoded.ok, true)
  if (!decoded.ok || !isRequest(decoded.value)) return
  assert.equal(decoded.value.config.enabled, false)
  assert.equal(decoded.value.config.stallNoticeThreshold, 5)
  assert.equal(decoded.value.config.maxResumes, 3)
  assert.equal(decoded.value.config.declarationSection, true)
})

test('配置里的非法数值回落到默认值', () => {
  const normalized = normalizeConfig({
    stallNoticeThreshold: 0,
    reminderThreshold: -2,
    reactionWindowMs: 1.5,
    maxResumes: 0,
  })
  // 阈值类必须为正，0 与负数都回落
  assert.equal(normalized.stallNoticeThreshold, 5)
  assert.equal(normalized.reminderThreshold, 3)
  assert.equal(normalized.reactionWindowMs, 30_000)
  // maxResumes 允许 0（语义是关闭续行）
  assert.equal(normalized.maxResumes, 0)
})
