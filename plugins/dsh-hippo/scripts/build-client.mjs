#!/usr/bin/env node
// build-client.mjs — client 半构建：esbuild 打成 CJS bundle，包进
// window.__ModuleLoader__.load({ id, factory }) 自注册壳（对齐 dsh-agentforge-brain
// 已验证的静态装配形态）。react 由宿主在运行时经 factory 的 require 注入，
// 构建期一律 external；@deepseek-ai/dsh-client-runtime 等仅 import type，
// 编译后不产生运行时引用，无需链接。
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'lib', 'client.js')

const result = await build({
  entryPoints: [join(ROOT, 'src', 'client.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  minify: false,
  write: false,
  sourcemap: false,
  logLevel: 'info',
})

const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-hippo",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${code.replace(/^/gm, '\t\t')}
\t\treturn module.exports;
\t}
});
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, wrapped, 'utf8')
console.log(`  wrote ${OUT} (${wrapped.length} bytes)`)
