/**
 * 配置校验测试：非法值必须抛出，不得静默回退。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, snapshot } from '../../src/config.ts'

test('空配置使用默认值（enabled 为 volatile 引用）', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled.get(), true)
  assert.equal(config.stallNoticeThreshold, 5)
})

test('合法自定义阈值被保留', () => {
  assert.equal(resolveConfig({ stallNoticeThreshold: 2 }).stallNoticeThreshold, 2)
})

test('阈值 0 / 负数 / 非整数 / 非数字都抛出，且错误信息含字段名', () => {
  for (const bad of [0, -1, 1.5, '5', null, Number.NaN]) {
    assert.throws(
      () => resolveConfig({ stallNoticeThreshold: bad }),
      /stallNoticeThreshold/,
      `应拒绝 ${String(bad)}`,
    )
  }
})

test('enabled 为 false 时引用读出 false', () => {
  assert.equal(resolveConfig({ enabled: false }).enabled.get(), false)
})

test('宿主已解析的配置（volatile 字段是引用）不得再跑一遍 schema', () => {
  // 回归：cordis 先用导出的 Config 解析，再把结果传给 apply；若 apply 里再校验一次，
  // volatile 引用会被当成普通值，抛 `$.enabled expected boolean but got [object Object]`，
  // 插件整条 entry 变成 inactive，target_status 根本不进工具池。
  const enabled = Object.freeze({ get: () => false })
  const reminderThreshold = Object.freeze({ get: () => 4 })
  const reactionWindowMs = Object.freeze({ get: () => 10_000 })
  const config = resolveConfig({ enabled, stallNoticeThreshold: 3, reminderThreshold, reactionWindowMs })

  assert.equal(config.enabled, enabled, '必须原样保留宿主给的引用')
  assert.equal(config.reminderThreshold, reminderThreshold)
  assert.equal(config.reactionWindowMs, reactionWindowMs)
  assert.equal(config.enabled.get(), false)
  assert.equal(config.stallNoticeThreshold, 3)
})

test('已解析路径下的非法阈值仍然抛出', () => {
  const enabled = Object.freeze({ get: () => true })
  const reminderThreshold = Object.freeze({ get: () => 3 })
  const reactionWindowMs = Object.freeze({ get: () => 30_000 })
  assert.throws(
    () => resolveConfig({ enabled, stallNoticeThreshold: 0, reminderThreshold, reactionWindowMs }),
    /stallNoticeThreshold/,
  )
})

test('已解析路径下 volatile 阈值非法时抛出，并指明字段', () => {
  const enabled = Object.freeze({ get: () => true })
  const reactionWindowMs = Object.freeze({ get: () => 30_000 })
  // 设置页写入 0 时应当立刻报错，而不是等到某次判定读到它才行为异常。
  assert.throws(
    () => resolveConfig({ enabled, stallNoticeThreshold: 5, reminderThreshold: Object.freeze({ get: () => 0 }), reactionWindowMs }),
    /reminderThreshold/,
  )
})

test('reactionWindowMs 非法时抛出', () => {
  for (const bad of [0, -1, 2.5, '30000']) {
    assert.throws(
      () => resolveConfig({ reactionWindowMs: bad }),
      /reactionWindowMs/,
      `应拒绝 ${String(bad)}`,
    )
  }
})

test('空配置下复述阈值与反应窗口取默认值', () => {
  const config = resolveConfig({})
  assert.equal(config.reminderThreshold.get(), 3)
  assert.equal(config.reactionWindowMs.get(), 30_000)
})

test('snapshot 把 volatile 引用拍平为普通值', () => {
  assert.deepEqual(snapshot(resolveConfig({ enabled: false, stallNoticeThreshold: 3 })), {
    enabled: false,
    stallNoticeThreshold: 3,
    reminderThreshold: 3,
    reactionWindowMs: 30_000,
  })
})
