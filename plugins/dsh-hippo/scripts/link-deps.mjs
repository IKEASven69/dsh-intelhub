#!/usr/bin/env node
// link-deps.mjs — 把 dsh checkout 里的宿主包 junction 链接到本地 node_modules，
// 供 tsdown 解析打包 host 半（@deepseek-ai/* 不在 npm 发布，devDependencies 里
// 不能声明它们——安装会 404；peerDependencies 声明兼容性，构建期靠本脚本供给）。
//
// 用法：node scripts/link-deps.mjs [checkout路径]
// 缺省 checkout = 环境变量 DSH_CHECKOUT 或 D:/coding/deepseek-harness。
import { existsSync, mkdirSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = resolve(process.argv[2] || process.env.DSH_CHECKOUT || 'D:/coding/deepseek-harness')

if (!existsSync(join(CHECKOUT, 'packages'))) {
  console.error(`link-deps: cannot locate the dsh checkout (${CHECKOUT}); set DSH_CHECKOUT`)
  process.exit(1)
}

// [本地 node_modules 相对路径, checkout 相对路径]——均为构建期供给：
// cordis 族供 tsdown 打包类型解析；webserver / client-runtime /
// ui-settings 仅供 tsc 类型检查（import type，编译后无运行时引用）。
// 本插件 host 侧零包依赖（cordis ctx 由宿主注入），client 侧仅 react（宿主 require）。
const LINKS = [
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['@deepseek-ai/cosmokit', 'vendor/cosmokit'],
  ['@deepseek-ai/schemastery', 'vendor/schemastery'],
  ['@deepseek-ai/dsh-host-webserver', 'packages/host/webserver'],
  ['@deepseek-ai/dsh-client-runtime', 'packages/client/runtime'],
  ['@deepseek-ai/dsh-client-ui-settings', 'packages/client/ui-settings'],
  ['@types/node', 'node_modules/@types/node'],
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

// @standard-schema/spec（cordis 的类型依赖，checkout 的 pnpm store 里）
const STD_DIR = join(CHECKOUT, 'node_modules', '.pnpm')
const STD_SPEC = readdirSync(STD_DIR).find((n) => n.startsWith('@standard-schema+spec@'))
if (STD_SPEC) {
  link(join(ROOT, 'node_modules', '@standard-schema', 'spec'), join(STD_DIR, STD_SPEC, 'node_modules', '@standard-schema', 'spec'))
} else {
  console.error('link-deps: @standard-schema/spec not found; skipLibCheck should cover it')
}

console.log('=== link-deps complete ===')
