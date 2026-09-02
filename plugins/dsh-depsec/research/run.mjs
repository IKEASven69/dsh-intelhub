/**
 * 语料判定：把 corpus.json 里每条 install 脚本喂给分析器，输出分布与明细。
 * 用法：npx tsx research/run.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { analyzeInstallScript } from '../src/script-analysis.ts'

const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'))
const results = []
const dist = { pass: 0, warn: 0, block: 0 }
const signalFreq = new Map()

for (const item of corpus) {
  const a = analyzeInstallScript(item.command)
  dist[a.verdict]++
  for (const s of a.signals) {
    const key = `${s.level}|${s.text.replace(/\s+/g, ' ').slice(0, 90)}`
    signalFreq.set(key, (signalFreq.get(key) ?? 0) + 1)
  }
  results.push({ ...item, verdict: a.verdict, signals: a.signals, filesRead: a.filesRead, filesMissing: a.filesMissing })
}

writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 1))

console.log(`语料 ${corpus.length} 条（${new Set(corpus.map((c) => c.name)).size} 包）`)
console.log(`判定分布: pass=${dist.pass} warn=${dist.warn} block=${dist.block}`)
console.log(`\n信号频次 TOP 30:`)
for (const [key, n] of [...signalFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${String(n).padStart(4)}  ${key}`)
}
