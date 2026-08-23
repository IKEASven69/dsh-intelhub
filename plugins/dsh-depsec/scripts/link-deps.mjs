#!/usr/bin/env node
// link-deps.mjs — 把 dsh checkout 的运行时包 junction 到本地 node_modules，
// 供 .build-tools/build.cjs 的 esbuild 解析打进宿主半产物（同 dsh-polymarket 先例：
// link: 安装的插件目录在 D:\coding 下，ESM 解析走不到 profile 的 node_modules，
// 宿主半必须自包含；客户端半仍保持外部化——浏览器运行时经 __ModuleLoader__ 提供）。
//
// 用法：node scripts/link-deps.mjs [checkout路径]
// 缺省 checkout = 环境变量 DSH_CHECKOUT 或 D:/coding/deepseek-harness。
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = resolve(process.argv[2] || process.env.DSH_CHECKOUT || 'D:/coding/deepseek-harness')

if (!existsSync(join(CHECKOUT, 'packages'))) {
  console.error(`link-deps: cannot locate the dsh checkout (${CHECKOUT}); set DSH_CHECKOUT`)
  process.exit(1)
}

// [本地 node_modules 相对路径, checkout 相对路径]
const LINKS = [
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai/dsh-typert-protocol', 'packages/typert/protocol'],
]

function link(target, from) {
  if (!existsSync(from)) {
    console.error(`link-deps: dependency target missing: ${from}`)
    process.exit(1)
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(resolve(from), resolve(target), process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`  linked ${target} -> ${from}`)
}

console.log(`=== Linking host-half bundle deps (checkout: ${CHECKOUT}) ===`)
for (const [name, path] of LINKS) {
  link(join(ROOT, 'node_modules', name), join(CHECKOUT, path))
}
console.log('=== link-deps complete ===')
