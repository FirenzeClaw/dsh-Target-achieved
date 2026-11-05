/**
 * 留痕测试：记录字段、落盘、保留策略、失败不影响判定。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { configureTrace, recordTrace, recentTraces, resetTraceState } from '../../src/trace.ts'

const asAgent = (id = 'root') => ({ id }) as unknown as Agent

/** 每个用例一个独立目录，避免相互污染。 */
function withTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'target-monitor-trace-'))
  configureTrace({ dir })
  return dir
}

test.afterEach(() => {
  resetTraceState()
})

test('一条记录写一行 JSONL，字段集合固定', () => {
  const dir = withTempDir()
  recordTrace(asAgent(), { turn: 3, outcome: 'injected', reason: 'undeclared', attempt: 1 })

  const lines = readFileSync(join(dir, 'gate-trace.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)

  const entry = JSON.parse(lines[0]!) as Record<string, unknown>
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['at', 'attempt', 'outcome', 'reason', 'session', 'turn'],
    '字段集合固定，多写或漏写都属于契约违规',
  )
  assert.equal(entry['turn'], 3)
  assert.equal(entry['outcome'], 'injected')
  assert.equal(entry['reason'], 'undeclared')
  assert.equal(entry['attempt'], 1)
  assert.equal(typeof entry['at'], 'number')
})

test('会话标识是 8 位十六进制短哈希，不落原值', () => {
  const dir = withTempDir()
  const agent = asAgent('session-abcdef-123456')
  recordTrace(agent, { turn: 1, outcome: 'released', reason: 'declared', attempt: 0 })

  const entry = JSON.parse(readFileSync(join(dir, 'gate-trace.jsonl'), 'utf8').trim()) as Record<string, unknown>
  assert.match(String(entry['session']), /^[0-9a-f]{8}$/, '必须是 8 位十六进制')
  assert.doesNotMatch(String(entry['session']), /session-abcdef/, '不得包含原始标识')
})

test('不同 agent 得到不同会话标识', () => {
  const dir = withTempDir()
  recordTrace(asAgent('first'), { turn: 1, outcome: 'injected', reason: 'undeclared', attempt: 1 })
  recordTrace(asAgent('second'), { turn: 1, outcome: 'injected', reason: 'undeclared', attempt: 1 })

  const entries = readFileSync(join(dir, 'gate-trace.jsonl'), 'utf8').trim().split('\n').map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  )
  assert.notEqual(entries[0]!['session'], entries[1]!['session'])
})

test('recentTraces 返回新→旧快照，且是副本', () => {
  withTempDir()
  const agent = asAgent()
  recordTrace(agent, { turn: 1, outcome: 'injected', reason: 'undeclared', attempt: 1 })
  recordTrace(agent, { turn: 2, outcome: 'released', reason: 'declared', attempt: 0 })

  const snapshot = recentTraces()
  assert.equal(snapshot.length, 2)
  assert.equal(snapshot[0]!.turn, 2, '最新的排在最前')

  // 副本：调用方改动不得影响内部缓冲。
  assert.throws(() => {
    ;(snapshot as unknown as unknown[]).push({})
  })
})

test('环形缓冲有上限，超出后丢弃最旧的', () => {
  withTempDir()
  configureTrace({ dir: undefined, capacity: 3 })
  const agent = asAgent()
  for (let turn = 1; turn <= 5; turn += 1) {
    recordTrace(agent, { turn, outcome: 'injected', reason: 'undeclared', attempt: 1 })
  }

  const snapshot = recentTraces()
  assert.equal(snapshot.length, 3)
  assert.deepEqual(snapshot.map((entry) => entry.turn), [5, 4, 3])
})

test('写入失败不抛出（留痕不得影响判定）', () => {
  // 用一个不可能成为目录的路径：已存在的普通文件下再建子目录必然失败。
  const filePath = join(tmpdir(), `target-monitor-not-a-dir-${process.pid}`)
  writeFileSync(filePath, 'x')
  configureTrace({ dir: join(filePath, 'nested') })

  assert.doesNotThrow(() => {
    recordTrace(asAgent(), { turn: 1, outcome: 'injected', reason: 'undeclared', attempt: 1 })
  })

  rmSync(filePath, { force: true })
})

test('超过上限时轮转为 .1，且只保留两个文件', () => {
  const dir = withTempDir()
  configureTrace({ dir, maxBytes: 200 })

  const agent = asAgent()
  // 每条记录约 110 字节，写三条必然越过 200 字节阈值。
  for (let turn = 1; turn <= 3; turn += 1) {
    recordTrace(agent, { turn, outcome: 'injected', reason: 'undeclared', attempt: 1 })
  }
  recordTrace(agent, { turn: 4, outcome: 'injected', reason: 'undeclared', attempt: 1 })

  assert.ok(existsSync(join(dir, 'gate-trace.jsonl.1')), '轮转文件必须存在')
  assert.ok(existsSync(join(dir, 'gate-trace.jsonl')))
  assert.equal(existsSync(join(dir, 'gate-trace.jsonl.2')), false, '最多保留两个文件')
})

test('resetTraceState 清空缓冲与失败标记', () => {
  withTempDir()
  recordTrace(asAgent(), { turn: 1, outcome: 'injected', reason: 'undeclared', attempt: 1 })
  assert.equal(recentTraces().length, 1)

  resetTraceState()
  assert.equal(recentTraces().length, 0)
})

test('测试进程内默认不落盘（避免污染用户真实日志目录）', () => {
  // 不显式给 dir：默认路径解析在 node --test 下必须返回 undefined。
  configureTrace({})
  recordTrace(asAgent(), { turn: 1, outcome: 'injected', reason: 'undeclared', attempt: 1 })

  assert.equal(recentTraces().length, 1, '内存缓冲照常记录')
  assert.ok(process.env['NODE_TEST_CONTEXT'] !== undefined, '本断言依赖 node --test 的进程标记')
})

test('三个续行 reason 可写入，且 errorCode 随记录落盘', () => {
  const dir = withTempDir()
  recordTrace(asAgent(), { turn: 4, outcome: 'injected', reason: 'upstream-resumed', attempt: 1, errorCode: 'RATE_LIMIT' })

  const entry = recentTraces()[0]
  assert.equal(entry?.reason, 'upstream-resumed')
  assert.equal(entry?.errorCode, 'RATE_LIMIT')

  const line = readFileSync(join(dir, 'gate-trace.jsonl'), 'utf8').trim()
  assert.equal(JSON.parse(line).errorCode, 'RATE_LIMIT')
})

test('errorCode 缺省时不出现该键——老记录形态保持不变', () => {
  withTempDir()
  recordTrace(asAgent(), { turn: 5, outcome: 'released', reason: 'declared', attempt: 0 })

  const entry = recentTraces()[0]
  assert.ok(entry !== undefined)
  assert.equal('errorCode' in entry, false, '可选字段缺省时不应写入')
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'attempt', 'outcome', 'reason', 'session', 'turn'])
})

test('既有六种 reason 语义与计数不变', () => {
  withTempDir()
  recordTrace(asAgent(), { turn: 6, outcome: 'released', reason: 'aborted', attempt: 0 })
  const entry = recentTraces()[0]
  assert.equal(entry?.reason, 'aborted')
  assert.equal(entry?.attempt, 0)
})
