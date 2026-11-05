/**
 * 客户端 bundle 的构建契约测试。
 *
 * 宿主只接受 `window.__ModuleLoader__.load({ id, factory })` 形式的产物，且工厂内
 * 只能用裸模块名 `require`。这两点若被破坏，表现是**启动即失败**（宿主会报
 * "missing bundle" 或运行期 require 解析不到），而不是某个测试变红——所以这里
 * 直接对 `dist/client.js` 断言，把问题挡在构建阶段。
 *
 * 前提：跑本测试前需已 `npm run build`。未构建时跳过，避免 `npm test` 在干净
 * 检出上因缺少产物而失败。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bundlePath = resolve(root, 'dist/client.js')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  dsh: { client?: { platform?: string } }
  files: string[]
}

const built = existsSync(bundlePath)
const bundle = built ? readFileSync(bundlePath, 'utf8') : ''

test('package.json 声明了 web 客户端与 ./client 导出', () => {
  assert.equal(manifest.dsh.client?.platform, 'web', 'dsh.client.platform 必须是 web')
  assert.equal(manifest.exports['./client'], './dist/client.js', '必须导出 ./client')
  assert.ok(manifest.files.includes('dist'), 'dist 必须在发布文件里')
})

test('bundle 以 ModuleLoader 包装，id 与包名一致', { skip: !built }, () => {
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundle, new RegExp(`id: ${JSON.stringify(manifest.name).replace(/[$]/g, '\\$&')}`))
  assert.match(bundle, /factory: \(require\) => \{/)
  assert.match(bundle, /return module\.exports;/)
})

test('bundle 不引用相对模块', { skip: !built }, () => {
  assert.doesNotMatch(
    bundle,
    /require\(\s*["']\.{1,2}\//,
    '宿主模块表不解析相对路径；客户端必须自包含',
  )
})

test('bundle 内联了规范正文，与宿主常量一致', { skip: !built }, async () => {
  const promptModule = await import(resolve(root, 'dist/prompt.js'))
  const declarationText = promptModule.DECLARATION_SECTION as string
  assert.ok(bundle.includes(JSON.stringify(declarationText)), '客户端复制的规范正文必须来自宿主构建产物')
})
