/**
 * 遗忘计数测试：注入 → 声明的时间窗判定、真中断不清零、阈值触发与清零。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { forgetForgetful, noteDeclaration, noteInjection, takeReminderDue } from '../../src/forget.ts'

/** 测试替身：状态以对象身份为键，不需要真实 Agent。 */
const asAgent = () => ({ id: 'a' }) as unknown as Agent

const WINDOW = 30_000

test('窗口内声明计一次', () => {
  const agent = asAgent()
  noteInjection(agent, 1_000)
  const count = noteDeclaration(agent, 1_000 + WINDOW, WINDOW)
  assert.equal(count, 1)
})

test('窗口外声明不计数', () => {
  const agent = asAgent()
  noteInjection(agent, 1_000)
  const count = noteDeclaration(agent, 1_000 + WINDOW + 1, WINDOW)
  assert.equal(count, 0)
})

test('没有待判定的注入时声明不计数', () => {
  const agent = asAgent()
  assert.equal(noteDeclaration(agent, 5_000, WINDOW), 0)
})

test('一次注入只计一次', () => {
  const agent = asAgent()
  noteInjection(agent, 1_000)
  noteDeclaration(agent, 1_500, WINDOW)
  assert.equal(noteDeclaration(agent, 1_600, WINDOW), 1)
})

test('真中断不清零：上一次注入未被响应后又注入，计数保持', () => {
  const agent = asAgent()
  noteInjection(agent, 1_000)
  noteDeclaration(agent, 1_100, WINDOW)
  // 第二次注入始终没等到声明，第三次注入把它顶掉
  noteInjection(agent, 2_000)
  noteInjection(agent, 3_000)
  assert.equal(noteDeclaration(agent, 3_100, WINDOW), 2)
})

test('未达阈值不触发复述', () => {
  const agent = asAgent()
  noteInjection(agent, 1_000)
  noteDeclaration(agent, 1_100, WINDOW)
  assert.equal(takeReminderDue(agent, 3), false)
})

test('达阈值触发复述并清零', () => {
  const agent = asAgent()
  for (let round = 0; round < 3; round += 1) {
    noteInjection(agent, 1_000 + round * 10)
    noteDeclaration(agent, 1_005 + round * 10, WINDOW)
  }
  assert.equal(takeReminderDue(agent, 3), true)
  // 清零后再触发需要重新累计
  assert.equal(takeReminderDue(agent, 3), false)
})

test('阈值提高后未达新阈值则不复述', () => {
  const agent = asAgent()
  for (let round = 0; round < 3; round += 1) {
    noteInjection(agent, 1_000 + round * 10)
    noteDeclaration(agent, 1_005 + round * 10, WINDOW)
  }
  assert.equal(takeReminderDue(agent, 4), false)
})

test('清理后计数归零', () => {
  const agent = asAgent()
  noteInjection(agent, 1_000)
  noteDeclaration(agent, 1_100, WINDOW)
  forgetForgetful(agent)
  assert.equal(takeReminderDue(agent, 1), false)
})

test('不同 agent 的计数互不影响', () => {
  const first = asAgent()
  const second = asAgent()
  noteInjection(first, 1_000)
  noteDeclaration(first, 1_100, WINDOW)
  assert.equal(takeReminderDue(second, 1), false)
  assert.equal(takeReminderDue(first, 1), true)
})
