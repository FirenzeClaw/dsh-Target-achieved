/**
 * 配置校验测试：非法值必须抛出，不得静默回退。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../../src/config.ts'

test('空配置使用默认值', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
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

test('enabled 为 false 时保持 false', () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
})
