/**
 * 生成浏览器 client bundle：lib/client.js。
 * 格式与官方 tsdown clientBundle 产物一致：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 * 源码为 CJS 形态，react / primitives 通过模块表的 require 解析。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ID = '@dsh-external/dsh-context-compactor'

const source = readFileSync(join(root, 'src', 'client', 'index.cjs'), 'utf8')
const bundle = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
  '  var module = { exports: {} };',
  '  var exports = module.exports;',
  source,
  '  return module.exports;',
  '} });',
  '',
].join('\n')

const outDir = join(root, 'lib')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'client.js'), bundle, 'utf8')
// 保持 lib/client.js 与 src 同步副本（便于直接查改）。
console.log('build: lib/client.js ready')
