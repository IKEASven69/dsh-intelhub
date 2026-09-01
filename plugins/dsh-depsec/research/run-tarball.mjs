/**
 * 全链路语料评测：下载语料包 tarball → 提取被引用的脚本文件 → 解析 npm run 委派 → 递归判定。
 * 消除「引用文件未读取」离线伪影，得到真实安装场景的判定分布。
 * 用法：node research/run-tarball.mjs   （可重复跑：tarball 缓存在 research/cache/）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { analyzeInstallScript, referencedScriptFiles } from '../src/script-analysis.ts'

const REGISTRY = 'https://registry.npmjs.org'
const CACHE = new URL('./cache/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
mkdirSync(CACHE, { recursive: true })

async function getJson(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (res.ok) return await res.json()
      if (res.status === 404) return null
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
  }
  return undefined
}

const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b

async function download(url, dest) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (isGzip(buf)) {
          writeFileSync(dest, buf)
          return true
        }
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
  }
  return false
}

/** 缓存文件有效（存在且 gzip 魔数）才可用；损坏的当场删掉。 */
function cachedTgz(tgz) {
  if (!existsSync(tgz)) return false
  const buf = readFileSync(tgz)
  if (isGzip(buf)) return true
  rmSync(tgz, { force: true })
  return false
}

/** 从 tarball 提取指定文件列表（package/ 前缀剥离），返回 相对路径 → 内容。 */
function extractFiles(tgz, wanted) {
  const out = {}
  // 逐文件取内容，避免一次提取多文件时内容串联歧义
  for (const w of wanted) {
    try {
      out[w] = execFileSync('tar', ['--force-local', '-xzf', tgz, '-O', `package/${w}`], { maxBuffer: 2 * 1024 * 1024 }).toString('utf8')
    } catch { /* 文件不在包里 */ }
  }
  return out
}

const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'))
const byPkg = new Map()
for (const c of corpus) {
  if (!byPkg.has(c.name)) byPkg.set(c.name, { version: c.version, commands: [] })
  byPkg.get(c.name).commands.push(c)
}
console.log(`语料 ${corpus.length} 条 / ${byPkg.size} 包，开始拉 tarball（缓存 ${CACHE}）`)

const results = []
const dist = { pass: 0, warn: 0, block: 0 }
let done = 0
let tarballs = 0
let delegationResolved = 0

for (const [name, info] of byPkg) {
  const key = `${name.replace(/\//g, '__')}-${info.version}.tgz`
  const tgz = CACHE + key
  const manifest = await getJson(`${REGISTRY}/${encodeURIComponent(name)}/${info.version}`)
  let files = {}
  let pkgScripts = {}
  if (manifest?.dist?.tarball !== undefined) {
    if (cachedTgz(tgz)) tarballs++
    else if (await download(manifest.dist.tarball, tgz)) tarballs++
    if (cachedTgz(tgz)) {
      // package.json 里的 scripts 供委派解析
      const pkgFiles = extractFiles(tgz, ['package.json'])
      try { pkgScripts = JSON.parse(pkgFiles['package.json'] ?? '{}').scripts ?? {} } catch { pkgScripts = {} }
      // 收集所有命令引用的本地 js
      const refs = new Set()
      for (const c of info.commands) for (const r of referencedScriptFiles(c.command)) refs.add(r)
      // 委派目标脚本本身也可能引用文件（一层）
      const delegated = []
      for (const c of info.commands) {
        const m = c.command.match(/\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+|test\b|start\b)?(?:--\s+)?([\w:@.-]+)/)
        const target = m !== null ? (pkgScripts[m[1] ?? ''] ?? (m[1] === 'test' ? pkgScripts.test : undefined)) : undefined
        if (typeof target === 'string') {
          delegated.push(target)
          for (const r of referencedScriptFiles(target)) refs.add(r)
        }
      }
      if (delegated.length > 0) delegationResolved += delegated.length
      // 顺带把常见 install 命名文件也带上（无扩展名引用时 node 会解析 .js）
      let dir = []
      try {
        dir = execFileSync('tar', ['--force-local', '-tzf', tgz]).toString().split('\n').filter((l) => /^package\/.*(install|postinstall|preinstall|setup|check)[^/]*\.(m|c)?js$/i.test(l))
      } catch { /* 列表失败就跳过，引用文件仍由 extractFiles 自行容错 */ }
      for (const d of dir) refs.add(d.replace(/^package\//, ''))
      files = extractFiles(tgz, [...refs].slice(0, 8))
    }
  }
  for (const c of info.commands) {
    const a = analyzeInstallScript(c.command, files)
    dist[a.verdict]++
    results.push({ ...c, verdict: a.verdict, signals: a.signals, filesRead: a.filesRead, filesMissing: a.filesMissing })
  }
  if (++done % 50 === 0) console.log(`  进度 ${done}/${byPkg.size}，tarball ${tarballs}，委派解析 ${delegationResolved}`)
}

writeFileSync(new URL('./results-tarball.json', import.meta.url), JSON.stringify(results, null, 1))
console.log(`\n完成：tarball ${tarballs}/${byPkg.size}，npm run 委派解析 ${delegationResolved} 条`)
console.log(`全链路判定分布: pass=${dist.pass} warn=${dist.warn} block=${dist.block}`)
const stillMissing = results.filter((r) => r.filesMissing.length > 0).length
console.log(`仍有引用未读到的条目: ${stillMissing}`)
