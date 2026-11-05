/**
 * 收尾判定纯函数的单元测试。
 *
 * 这组用例是守护进程与进程内实现共同的规格：两侧都只调用 `planTurnStopping`，
 * 因此只要这里的分支是对的，两边的判定就不会分叉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TargetMonitorConfig } from '../../src/config.ts'
import { planTurnStopping, type TurnStoppingPlanInput } from '../../src/monitor/plan.ts'

const config: TargetMonitorConfig = {
  enabled: true,
  stallNoticeThreshold: 5,
  reminderThreshold: 3,
  reactionWindowMs: 30_000,
  resumeOnUpstreamError: true,
  maxResumes: 3,
}

function input(overrides: Partial<TurnStoppingPlanInput> = {}): TurnStoppingPlanInput {
  return {
    enabled: true,
    isRoot: true,
    cause: 'undeclared',
    declared: false,
    repairs: 0,
    noticeShown: false,
    forgetCount: 0,
    config,
    ...overrides,
  }
}

test('总开关关闭时放行，原因为 disabled', () => {
  const plan = planTurnStopping(input({ enabled: false }))
  assert.equal(plan.inject, false)
  assert.equal(plan.reason, 'disabled')
})

test('非顶层 agent 放行，原因为 not-root', () => {
  const plan = planTurnStopping(input({ isRoot: false }))
  assert.equal(plan.inject, false)
  assert.equal(plan.reason, 'not-root')
})

test('结束原因不适用时放行，原因为 error', () => {
  const plan = planTurnStopping(input({ cause: 'not-applicable' }))
  assert.equal(plan.inject, false)
  assert.equal(plan.reason, 'error')
})

test('本轮已声明时放行，原因为 declared', () => {
  const plan = planTurnStopping(input({ declared: true }))
  assert.equal(plan.inject, false)
  assert.equal(plan.reason, 'declared')
})

test('未声明时注入，次数是既有次数加一', () => {
  const plan = planTurnStopping(input({ repairs: 2 }))
  assert.equal(plan.inject, true)
  assert.equal(plan.reason, 'undeclared')
  assert.equal(plan.attempt, 3)
})

test('截断原因被原样带回，供文案选择区分', () => {
  assert.equal(planTurnStopping(input({ cause: 'truncated' })).cause, 'truncated')
})

test('遗忘次数达到阈值时追加复述', () => {
  assert.equal(planTurnStopping(input({ forgetCount: 2 })).reminder, false)
  assert.equal(planTurnStopping(input({ forgetCount: 3 })).reminder, true)
})

test('卡住提示只在达到阈值且本轮未展示时出现一次', () => {
  // 阈值 5：repairs 为 3 时本次是第 4 次，未到；repairs 为 4 时本次是第 5 次，到。
  assert.equal(planTurnStopping(input({ repairs: 3 })).stallNotice, false)
  assert.equal(planTurnStopping(input({ repairs: 4 })).attempt, 5)
  assert.equal(planTurnStopping(input({ repairs: 4 })).stallNotice, true)
  // 已展示过就不再重复
  assert.equal(planTurnStopping(input({ repairs: 4, noticeShown: true })).stallNotice, false)
})

test('放行的计划不带注入相关字段', () => {
  const plan = planTurnStopping(input({ declared: true, forgetCount: 9, repairs: 9 }))
  assert.equal(plan.attempt, 0)
  assert.equal(plan.reminder, false)
  assert.equal(plan.stallNotice, false)
})
