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

test('bundle 声明了 remote.settings 注入，否则设置分区会在渲染期崩溃', { skip: !built }, async () => {
  // 回归：typert 远程代理的属性有独立访问门。只注入 `remote` 时，组件里读
  // `ctx.remote.settings` 会抛 `cannot get property "remote.settings" without inject`；
  // 抛出点在渲染期，宿主把整条 section 撤下（面板空白），类型检查发现不了。
  const vm = await import('node:vm')
  let loaded: { inject?: unknown } | undefined
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }: { factory: (require: (name: string) => unknown) => { inject?: unknown } }) => {
          loaded = factory((name: string) => {
            if (name === 'react') {
              return {
                useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
                useEffect: () => {},
                useMemo: (fn: () => unknown) => fn(),
                useRef: (value: unknown) => ({ current: value }),
              }
            }
            if (name === 'react/jsx-runtime') {
              return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
            }
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox)

  const inject = loaded?.inject
  assert.ok(Array.isArray(inject), 'bundle 必须导出 inject 数组')
  assert.ok(inject.includes('remote.settings'), "inject 必须含 'remote.settings'")
  assert.ok(inject.includes('slots'), "inject 必须含 'slots'")
})

test('bundle 把分区注册到 settings.section，id 与 profile 条目一致', { skip: !built }, async () => {
  const vm = await import('node:vm')
  const registered: { options?: Record<string, unknown> }[] = []
  let loaded: { apply?: (context: unknown) => void } | undefined
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }: { factory: (require: (name: string) => unknown) => { apply?: (context: unknown) => void } }) => {
          loaded = factory((name: string) => {
            if (name === 'react') {
              return { useState: (init: unknown) => [init, () => {}], useEffect: () => {}, useMemo: (fn: () => unknown) => fn(), useRef: () => ({}) }
            }
            if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox)

  loaded?.apply?.({
    remote: { settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }) } },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Record<string, unknown>) => {
        registered.push({ options })
        return () => {}
      },
    },
  })

  const entry = registered.find((item) => item.options?.['name'] === 'settings.section')
  assert.ok(entry !== undefined, '必须注册 settings.section 分区')
  assert.equal(entry.options?.['id'], 'target-monitor', '分区 id 必须与 profile 条目 id 一致')
})
