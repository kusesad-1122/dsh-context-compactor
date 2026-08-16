/**
 * dsh-context-compactor build:
 * 1. src/index.js → lib/index.js
 * 2. 在插件自己的 node_modules 下建 @deepseek-ai peer junction，
 *    指向当前激活 profile 的 node_modules（版本与 host 运行版本严格一致），
 *    保证运行时从插件真实路径也能解析依赖。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 编译产物
const libDir = join(root, 'lib')
mkdirSync(libDir, { recursive: true })
copyFileSync(join(root, 'src', 'index.js'), join(libDir, 'index.js'))
// 进程内热激活入口：唯一用途是被 dev_stage 工具以全新 URL 动态 import，
// 绕开 loader 对 lib/index.js 的陈旧模块缓存。
copyFileSync(join(root, 'src', 'index.js'), join(libDir, 'index.live.js'))

// 运行期 peer junction：优先 DSH_HOME，其次 ~/.dsh。
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileNodeModules = join(dshHome, 'profiles', 'node_modules')
const peers = [
  'dsh-compaction',
  'dsh-compaction-basic',
  'dsh-compaction-tool-result-pruner',
  'dsh-llm',
]
const linkRoot = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(linkRoot, { recursive: true })

for (const peer of peers) {
  const target = join(profileNodeModules, '@deepseek-ai', peer)
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`build: peer package missing at ${target} (DSH_HOME=${dshHome})`)
    process.exit(1)
  }
  const link = join(linkRoot, peer)
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`build: linked ${peer} -> ${target}`)
}

console.log('build: lib/index.js ready')

// 生成浏览器 client bundle（lib/client.js）
await import('./build-client.mjs')
