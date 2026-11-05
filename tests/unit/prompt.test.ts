/**
 * 文案测试：三条硬性要求（非用户消息、否认授权、三个出口）与长度上限。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DECLARATION_SECTION, repairText, stallNoticeText } from '../../src/prompt.ts'

test('声明协议章节含两个状态与后果说明', () => {
  assert.match(DECLARATION_SECTION, /done/)
  assert.match(DECLARATION_SECTION, /awaiting_user/)
  assert.match(DECLARATION_SECTION, /unfinished/)
})

test('声明协议必须写明"先声明，再汇报/等待"的顺序（spec 005 / FR-006）', () => {
  // 只说"收尾前要声明"不够：模型会先写完汇报再补声明，而那时轮次已要关闭。
  assert.match(DECLARATION_SECTION, /Declare first, then report/i)
  assert.match(DECLARATION_SECTION, /call target_status\("done"\) first, then report/i)
  assert.match(DECLARATION_SECTION, /call target_status\("awaiting_user"\) first, then ask/i)
})

test('提醒文案含三个出口', () => {
  const text = repairText('undeclared', 1)
  assert.match(text, /target_status\("done"\)/)
  assert.match(text, /target_status\("awaiting_user"\)/)
  assert.match(text, /continue from where you stopped/i)
})

test('提醒文案显式否认授权且标为非用户消息', () => {
  const text = repairText('undeclared', 1)
  assert.match(text, /NOT a user message/)
  assert.match(text, /not user approval or consent/)
  assert.match(text, /does not lift any confirmation requirement/)
})

test('提醒以"继续工作"开场，不复述模型行为问题（避免引发回避性分心）', () => {
  const text = repairText('undeclared', 2)
  // 本项目只维持推进，不纠正模型：把收尾诊断成"失误"会诱发后续的规避行为。
  assert.match(text, /Continue from where you stopped/)
  assert.doesNotMatch(text, /attempted to close/i)
  assert.doesNotMatch(text, /without declaring/i)
  assert.doesNotMatch(text, /previous turn/i)
})

test('截断变体说明工具未执行，普通变体不含该句', () => {
  assert.match(repairText('truncated', 1), /were not executed/)
  assert.doesNotMatch(repairText('undeclared', 1), /were not executed/)
})

test('提醒长度保持在契约上限内（< 1.5 KB）', () => {
  for (const attempt of [1, 5, 11]) {
    const bytes = Buffer.byteLength(repairText('truncated', attempt), 'utf8')
    assert.ok(bytes < 1536, `attempt ${attempt} 长度 ${bytes} 超限`)
  }
})

test('卡住提示提到阈值且面向用户', () => {
  const text = stallNoticeText(5)
  assert.match(text, /5/)
  assert.match(text, /卡住/)
})
