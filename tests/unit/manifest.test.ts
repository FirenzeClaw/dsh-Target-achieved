/**
 * 打包契约测试：清单字段与 bundle 补丁必须满足安装器与市场的要求。
 *
 * 这些字段错了不会在运行时暴露——插件本地照常工作（因为走 link: 挂载），
 * 只有别人装不上或市场拒绝收录时才被发现。所以必须在这里挡住。
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../..', import.meta.url).pathname
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>

test('守护进程入口随包分发（spec 007）', () => {
  const files = manifest.files as string[]
  assert.ok(files.includes('dist'), 'files 必须包含 dist')
  // 入口是 dist/daemon/main.js：拉起逻辑按 import.meta.url 相对解析，
  // 少发这个文件等于跨进程模式在安装后立刻失效。
  const daemonMain = new URL('../../dist/daemon/main.js', import.meta.url)
  assert.equal(existsSync(daemonMain), true, 'dist/daemon/main.js 必须存在（先 npm run build）')
})

test('不得带 private 标记（否则安装器拒绝作为 bundle 发布）', () => {
  assert.equal(manifest['private'], undefined)
})

test('声明 DSH 清单版本与 bundle 补丁路径', () => {
  const dsh = manifest['dsh'] as { manifestVersion?: unknown; bundle?: { patch?: unknown } } | undefined
  assert.equal(dsh?.manifestVersion, 1, 'manifestVersion 必须是数字 1')
  assert.equal(dsh?.bundle?.patch, 'dsh.bundle.patch')
})

test('bundle 补丁文件存在且被 files 收录', () => {
  assert.ok(existsSync(join(root, 'dsh.bundle.patch')), '补丁文件必须真实存在，否则安装时报错')
  assert.ok((manifest['files'] as string[]).includes('dsh.bundle.patch'))
})

test('补丁只做 insert，不改宿主既有条目', () => {
  const patch = readFileSync(join(root, 'dsh.bundle.patch'), 'utf8')
  // 只允许 insert：出现 id/config 的顶层覆盖意味着会改动用户的既有配置。
  const topLevelKeys = patch
    .split('\n')
    .filter((line) => /^- \w/.test(line))
    .map((line) => line.slice(2).split(':')[0])
  assert.deepEqual([...new Set(topLevelKeys)], ['insert'])
  assert.match(patch, /id: target-monitor/)
})

test('engines 声明兼容宿主版本范围', () => {
  const engines = manifest['engines'] as Record<string, unknown>
  assert.equal(engines['dsh'], '>=0.2.1-rc.5 <0.3.0')
  assert.equal(engines['node'], '>=22')
})

test('宿主包只在 peerDependencies，不进 dependencies', () => {
  const deps = (manifest['dependencies'] ?? {}) as Record<string, string>
  const peer = (manifest['peerDependencies'] ?? {}) as Record<string, string>

  const hostPackages = Object.keys(peer).filter((name) => name.startsWith('@deepseek-ai/'))
  assert.ok(hostPackages.length >= 5, '宿主包应全部声明为 peer')
  for (const name of hostPackages) {
    assert.equal(deps[name], undefined, `${name} 不得出现在 dependencies，否则用户环境会出现重复副本`)
  }
})

test('发布元数据齐备（市场清单需要）', () => {
  assert.equal(typeof manifest['description'], 'string')
  assert.match(String(manifest['license']), /^[A-Z]/)
  assert.match(String((manifest['repository'] as { url?: string })?.url), /github\.com[:/]FirenzeClaw\/dsh-Target-achieved/)
  assert.ok(Array.isArray(manifest['keywords']) && (manifest['keywords'] as string[]).length > 0)
})

test('入口指向 dist，且 dist 被 files 收录', () => {
  const exportsField = manifest['exports'] as { '.': { import?: string; types?: string } }
  assert.match(String(exportsField['.'].import), /^\.\/dist\//)
  assert.match(String(exportsField['.'].types), /^\.\/dist\//)
  assert.ok((manifest['files'] as string[]).includes('dist'))
})

test('许可文件存在且被 files 收录（声明 MIT 就必须真的给出许可文本）', () => {
  assert.ok(existsSync(join(root, 'LICENSE')), 'package.json 声明 MIT，仓库内必须有 LICENSE')
  assert.ok((manifest['files'] as string[]).includes('LICENSE'))
  const text = readFileSync(join(root, 'LICENSE'), 'utf8')
  assert.match(text, /^MIT License/)
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/, '必须是完整的 MIT 免责条款')
})

test('版本与变更记录一致（引入版本号后必须同步维护）', () => {
  const version = String(manifest['version'])
  assert.match(version, /^\d+\.\d+\.\d+$/, '必须使用语义化版本')

  const changelogPath = join(root, 'CHANGELOG.md')
  assert.ok(existsSync(changelogPath), '引入版本号后必须有 CHANGELOG')
  const changelog = readFileSync(changelogPath, 'utf8')
  assert.match(changelog, new RegExp(`## \\[${version.replaceAll('.', '\\.')}\\]`), '当前版本必须在 CHANGELOG 中有条目')
  assert.ok((manifest['files'] as string[]).includes('CHANGELOG.md'))
})
