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

test('宿主已解析的配置（enabled 是 volatile 引用）不得再跑一遍 schema', () => {
  // 回归：cordis 先用导出的 Config 解析，再把结果传给 apply；若 apply 里再校验一次，
  // volatile 引用会被当成布尔值，抛 `$.enabled expected boolean but got [object Object]`，
  // 插件整条 entry 变成 inactive，target_status 根本不进工具池。
  const enabled = Object.freeze({ get: () => false })
  const config = resolveConfig({ enabled, stallNoticeThreshold: 3 })
  assert.equal(config.enabled, enabled, '必须原样保留宿主给的引用')
  assert.equal(config.enabled.get(), false)
  assert.equal(config.stallNoticeThreshold, 3)
})

test('已解析路径下的非法阈值仍然抛出', () => {
  const enabled = Object.freeze({ get: () => true })
  assert.throws(() => resolveConfig({ enabled, stallNoticeThreshold: 0 }), /stallNoticeThreshold/)
})

test('snapshot 把 volatile 引用拍平为普通值', () => {
  assert.deepEqual(snapshot(resolveConfig({ enabled: false, stallNoticeThreshold: 3 })), {
    enabled: false,
    stallNoticeThreshold: 3,
  })
})
