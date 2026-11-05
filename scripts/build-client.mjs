#!/usr/bin/env node
/**
 * 把 tsc 产出的 CommonJS 客户端代码包装成宿主可加载的 bundle。
 *
 * 为什么需要这一步：宿主只接受 `window.__ModuleLoader__.load({ id, factory })`
 * 形式的产物（见 dsh-client-modules/README.md「Build requirements」），工厂内部是
 * CommonJS，依赖经 `require("裸模块名")` 从宿主模块表取。tsc 直出的 ESM 无法加载，
 * 而引入 bundler 会打破本项目「构建只有 tsc」的约定，故用本脚本完成最后一步。
 *
 * 同时做两件校验：
 *   1. 产物不得含相对 require——宿主模块表不解析相对路径；
 *   2. 规范正文从宿主构建产物读取后注入，避免客户端复制一份而漂移。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'dist/client-raw/index.js')
const outputPath = resolve(root, 'dist/client.js')

const source = readFileSync(sourcePath, 'utf8')

const relativeRequire = /require\(\s*["']\.{1,2}\//.exec(source)
if (relativeRequire !== null) {
  throw new Error(
    `客户端产物含相对 require（${relativeRequire[0]}）：宿主模块表只解析裸模块名。` +
      '请把客户端代码收敛到 src/client/index.ts 单文件。',
  )
}

// 规范正文取自宿主侧构建产物，保证设置页复制的文本与真实注入一致。
const promptModule = await import(resolve(root, 'dist/prompt.js'))
const declarationText = promptModule.DECLARATION_SECTION
if (typeof declarationText !== 'string' || declarationText.length === 0) {
  throw new Error('dist/prompt.js 未导出 DECLARATION_SECTION，无法注入客户端常量')
}

// 关闭初始注入时写进用户级 AGENTS.md 的片段：标题 + 规范正文。
const agentsSnippet = `## Target status declaration\n\n${declarationText}`

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const id = packageJson.name
if (typeof id !== 'string' || id.length === 0) throw new Error('package.json 缺少 name')

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tvar __TM_DECLARATION_TEXT__ = ${JSON.stringify(declarationText)};
\t\tvar __TM_AGENTS_SNIPPET__ = ${JSON.stringify(agentsSnippet)};
${source}
\t\treturn module.exports;
\t}
});
`

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, bundle, 'utf8')

process.stdout.write(`client bundle: ${outputPath} (${Buffer.byteLength(bundle)} bytes)\n`)
