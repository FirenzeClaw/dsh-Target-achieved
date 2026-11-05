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
  // 真实宿主解析后一定包含全部字段（schema 会填默认值），这里如实模拟。
  const resumeOnUpstreamError = Object.freeze({ get: () => true })
  const maxResumes = Object.freeze({ get: () => 2 })
  const config = resolveConfig({
    enabled,
    stallNoticeThreshold: 3,
    reminderThreshold,
    reactionWindowMs,
    resumeOnUpstreamError,
    maxResumes,
  })

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
  assert.deepEqual(snapshot(resolveConfig({ enabled: false, stallNoticeThreshold: 3, maxResumes: 2 })), {
    enabled: false,
    stallNoticeThreshold: 3,
    reminderThreshold: 3,
    reactionWindowMs: 30_000,
    resumeOnUpstreamError: true,
    maxResumes: 2,
  })
})

test('续行配置有默认值：开关打开、上限 3', () => {
  const config = resolveConfig({})
  assert.equal(config.resumeOnUpstreamError.get(), true)
  assert.equal(config.maxResumes.get(), 3)
  const flat = snapshot(config)
  assert.equal(flat.resumeOnUpstreamError, true)
  assert.equal(flat.maxResumes, 3)
})

test('maxResumes 允许 0（等于关闭自动续行），拒绝负数与小数', () => {
  assert.equal(resolveConfig({ maxResumes: 0 }).maxResumes.get(), 0)
  for (const bad of [-1, 1.5, '3', null, Number.NaN]) {
    assert.throws(() => resolveConfig({ maxResumes: bad }), /maxResumes/, `应拒绝 ${String(bad)}`)
  }
})

test('两个续行字段必须是 volatile 引用（设置页靠这个自动生成表单）', () => {
  const config = resolveConfig({})
  assert.equal(typeof config.resumeOnUpstreamError.get, 'function')
  assert.equal(typeof config.maxResumes.get, 'function')
})

test('已解析配置里续行字段若不是引用则抛出，不得静默当普通值用', () => {
  const enabled = Object.freeze({ get: () => true })
  const reminderThreshold = Object.freeze({ get: () => 3 })
  const reactionWindowMs = Object.freeze({ get: () => 30_000 })
  assert.throws(
    () => resolveConfig({ enabled, reminderThreshold, reactionWindowMs, resumeOnUpstreamError: true }),
    /resumeOnUpstreamError/,
  )
})

test('已解析配置里续行字段的非法取值同样抛出（设置页写入即报错）', () => {
  const enabled = Object.freeze({ get: () => true })
  const reminderThreshold = Object.freeze({ get: () => 3 })
  const reactionWindowMs = Object.freeze({ get: () => 30_000 })
  assert.throws(
    () =>
      resolveConfig({
        enabled,
        reminderThreshold,
        reactionWindowMs,
        resumeOnUpstreamError: Object.freeze({ get: () => true }),
        maxResumes: Object.freeze({ get: () => -2 }),
      }),
    /maxResumes/,
  )
})
