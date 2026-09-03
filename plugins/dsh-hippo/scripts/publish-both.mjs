#!/usr/bin/env node
/**
 * publish-both.mjs（H10 M1）：同源构建 → 双发布包。
 *
 *   dsh-hippo      → dsh market（name/files/dsh 字段原样）
 *   hippo-context  → npm 桌面端（换 name/description/keywords，去 dsh 字段，README 换 npm 版）
 *
 * 动作只到 npm pack --dry-run 为止；真正 publish 由人执行：
 *   cd dist-publish/dsh-hippo    && npm publish
 *   cd dist-publish/hippo-context && npm publish --access public
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'dist-publish')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/** 需要进发布包的公共内容（两包共用）。 */
const COMMON_FILES = ['lib/', 'dist/', 'web/dist/', 'cordis.patch.yml', 'skills/', 'scripts/', 'LICENSE']

function buildVariant(name, { readme, description, keywords, dropDsh }) {
  const dir = join(OUT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const f of COMMON_FILES) {
    const src = join(ROOT, f)
    if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true })
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const out = {
    name,
    version: VERSION,
    description,
    type: pkg.type,
    main: pkg.main,
    types: pkg.types,
    bin: pkg.bin,
    exports: dropDsh
      ? {
          '.': { types: './dist/hippo/engine.d.ts', default: './dist/hippo/engine.js' },
          './client': './lib/client.js',
          './package.json': './package.json',
        }
      : pkg.exports,
    files: [...COMMON_FILES.map((f) => f.replace(/\/$/, '')), 'package.json', 'README.md'],
    license: pkg.license,
    scripts: { postinstall: pkg.scripts?.postinstall ?? '' },
    dependencies: pkg.dependencies,
    ...(keywords ? { keywords } : {}),
    ...(dropDsh ? {} : { peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta }),
    ...(!dropDsh ? { dsh: pkg.dsh } : {}),
  }
  if (out.scripts.postinstall === '') delete out.scripts
  // engines：桌面端用户可能用 npm 装全局——沿用引擎要求
  out.engines = { node: '>=18' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(out, null, 2), 'utf-8')
  // README：两包各用各的
  const readmeSrc = join(ROOT, readme)
  if (existsSync(readmeSrc)) cpSync(readmeSrc, join(dir, 'README.md'))
  return dir
}

console.log(`[publish-both] v${VERSION} · 构建双发布包 → dist-publish/`)
const dshDir = buildVariant('dsh-hippo', {
  readme: 'README.md',
  description: '记忆桥：把 Claude Code / Codex / opencode 会话里积累的记忆蒸馏进 dsh——开局即认识你的项目与偏好（引擎已内置，hippo gui 另有桌面端用）',
  dropDsh: false,
})
const npmDir = buildVariant('hippo-context', {
  readme: 'README-npm.md',
  description: 'Hippo Context — local-first experience engine for AI coding agents. Sessions in, context out. 桌面工作台 + MCP + Memoryfields 镜像，零 API key。',
  keywords: ['ai', 'agent', 'memory', 'context', 'mcp', 'local-first', 'memoryfield', 'hippo'],
  dropDsh: true,
})

console.log('\n[publish-both] npm pack --dry-run 校验：')
for (const dir of [dshDir, npmDir]) {
  const name = dirname(dir).split(/[\\/]/).pop()
  try {
    const out = execSync('npm pack --dry-run', { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const total = /total files|package size/.exec(out)?.[0] ?? ''
    console.log(`  ✅ ${name}: pack ok`)
  } catch (e) {
    console.error(`  ❌ ${name}: ${(e.stderr || e.message).toString().slice(0, 200)}`)
    process.exitCode = 1
  }
}
console.log(`
[publish-both] 完成。发布（人执行）：
  cd ${dshDir} && npm publish
  cd ${npmDir} && npm publish --access public
`)
