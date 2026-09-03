/** 真实语料误报测量：扫本地全部真实技能/命令文件，统计 verdict 分布与命中明细。 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isModelFacingFile, scanInjectedText } from '../src/prompt-injection.ts'

const ROOTS = ['D:/coding/Skills', 'D:/coding/dsh-plugin/plugins', 'D:/coding/hippo-skills']
const files = []
function walk(dir) {
  let es
  try { es = readdirSync(dir) } catch { return }
  for (const e of es) {
    if (e === 'node_modules' || e === '.git' || e === 'lib') continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p)
    else if (st.isFile() && isModelFacingFile(p) && st.size < 200_000) files.push(p)
  }
}
for (const r of ROOTS) walk(r)

const dist = { pass: 0, warn: 0, block: 0 }
const hits = []
for (const f of files) {
  const a = scanInjectedText(f, readFileSync(f, 'utf8'))
  dist[a.verdict]++
  if (a.verdict !== 'pass') hits.push({ f, verdict: a.verdict, findings: a.findings.slice(0, 3) })
}
console.log(`真实语料 ${files.length} 个文件 → pass=${dist.pass} warn=${dist.warn} block=${dist.block}`)
for (const h of hits) {
  console.log(`\n[${h.verdict}] ${h.f}`)
  for (const fd of h.findings) console.log(`  ${fd.severity} ${fd.category} L${fd.line} :: ${fd.snippet.slice(0, 80)}`)
}
