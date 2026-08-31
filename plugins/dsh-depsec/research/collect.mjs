/**
 * 语料采集：从 npm registry 拉人气 top 包的 install 生命周期脚本。
 * 数据源：registry search API（按 popularity 权重）+ 逐包 latest manifest 的 scripts 字段。
 * 输出：research/corpus.json — [{name, version, scriptType, command}]
 */
import { writeFileSync } from 'node:fs'

const REGISTRY = 'https://registry.npmjs.org'

/** 网络间歇抖动：每个请求最多重试 5 次，指数退避。 */
async function getJson(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (res.ok) return await res.json()
      if (res.status === 404) return null
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
  }
  return undefined // 网络失败（区别于 404 的 null）
}
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'prepack', 'postpack', 'preuninstall', 'postuninstall', 'prepare']

const names = new Set()
// search API 按 popularity 权重排序；用多组种子查询覆盖主流生态，每页 250，去重
const SEEDS = ['keywords:javascript', 'keywords:typescript', 'keywords:nodejs', 'keywords:react', 'keywords:cli', 'keywords:build-tool', 'keywords:webpack', 'keywords:testing']
for (const seed of SEEDS) {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(seed)}&size=250&quality=0.0&popularity=1.0&maintenance=0.0`
  const data = await getJson(url)
  if (!data?.objects) { console.error(`search ${seed} failed`); continue }
  for (const obj of data.objects) names.add(obj.package.name)
}
console.log(`候选包: ${names.size}`)

const corpus = []
let done = 0, withScripts = 0
for (const name of names) {
  const manifest = await getJson(`${REGISTRY}/${encodeURIComponent(name)}/latest`)
  if (manifest === undefined) { console.error(`${name}: 网络失败`); done++; continue }
  if (manifest === null || manifest === undefined) { done++; continue }
  const scripts = manifest.scripts ?? {}
  for (const type of LIFECYCLE) {
    const cmd = scripts[type]
    if (typeof cmd === 'string' && cmd.trim()) {
      corpus.push({ name, version: manifest.version, scriptType: type, command: cmd })
      withScripts++
    }
  }
  if (++done % 200 === 0) console.log(`  进度 ${done}/${names.size}，命中生命周期脚本 ${withScripts} 条`)
}

writeFileSync(new URL('./corpus.json', import.meta.url), JSON.stringify(corpus, null, 1))
console.log(`完成: ${corpus.length} 条生命周期脚本，来自 ${new Set(corpus.map((c) => c.name)).size} 个包`)
