/**
 * 边界契约测试：锁定"不做的事"。
 *
 * 这几条是 MUST NOT 型需求（FR-013 / FR-011 / FR-006）。没有测试，
 * 后续有人"顺手补个重试"或"把来源改成 user"时不会有任何东西拦他。
 * 断言对象是源码文本本身——粗糙但有效，且不依赖宿主运行时。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { inject } from '../../src/index.ts'

const src = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), 'utf8')

test('FR-013：不得接管请求重试，也不得自行开新轮次', async () => {
  const entry = await src('index.ts')
  assert.equal(entry.includes('agent/request-error'), false, '不得订阅 request-error')
  assert.equal(entry.includes('.followup('), false, '不得用 followup 自行开轮')
})

test('FR-011：取消路径必须先判 aborted，再考虑注入', async () => {
  const entry = await src('index.ts')
  assert.match(entry, /signal\.aborted/)
  // aborted 判定必须出现在判定入口之前（spec 007 后入口从 handleTurnStopping
  // 换成了 monitor.turnStopping，守卫位置不变）
  assert.ok(
    entry.indexOf('signal.aborted') < entry.indexOf('monitor.turnStopping('),
    'aborted 守卫必须在注入之前',
  )
})

test('FR-006：提醒来源不得是 user', async () => {
  const notices = await src('notices.ts')
  assert.equal(/kind:\s*'user'/.test(notices), false)
  assert.match(notices, /kind: 'target-monitor'/)
})

test('FR-014：门不得读取助手文本内容做判定', async () => {
  const gate = await src('gate.ts')
  assert.equal(gate.includes('content'), false, '门不应触碰消息 content')
})

test('FR-015：inject 声明了所需服务，缺失即启动失败', () => {
  assert.deepEqual([...inject].sort(), ['agents', 'systemPrompt', 'tools'])
})
