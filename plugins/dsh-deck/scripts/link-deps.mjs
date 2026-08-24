#!/usr/bin/env node
// link-deps.mjs — 把 dsh checkout 的运行时包 junction 到本地 node_modules，
// 供 tsdown 解析打包 + tsc/vitest 类型（同 dsh-polymarket / dsh-depsec 先例）。
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
  ['@deepseek-ai/dsh-host-webserver', 'packages/host/webserver'],
  ['schemastery', 'vendor/schemastery'],
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

console.log(`=== Linking build dependencies (checkout: ${CHECKOUT}) ===`)
for (const [name, path] of LINKS) {
  link(join(ROOT, 'node_modules', name), join(CHECKOUT, path))
}
console.log('=== link-deps complete ===')
