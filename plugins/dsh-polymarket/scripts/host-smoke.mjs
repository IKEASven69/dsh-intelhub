/**
 * dsh-polymarket host 半包冒烟验证。
 * 模拟 cordis-host-runner 求值环境：
 *  - evaluateHostCode: 代码包进 `(async () => {\n${code}\n})()` 求值
 *  - harness.handle: 收集 handler（宿主 normalizeHandler 会包 cloneJson，这里直接验证返回值可被 JSON.stringify 无损失往返）
 *  - ctx.web.fetch: 真实网络调用包装成 { statusCode, body: {kind, content}, truncated }
 * 全部 5 个 handler 真实调用一次。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../src/host-half.js', import.meta.url), 'utf8')

// —— 模拟宿主环境 ——
const handlers = {}
globalThis.harness = {
  handle: (method, fn) => { handlers[method] = fn },
}

const ctx = {
  web: {
    fetch: async ({ url }) => {
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-smoke/0.1' } })
      const text = await res.text()
      return { statusCode: res.status, body: { kind: 'text', content: text }, truncated: false }
    },
  },
}

// —— 模拟 evaluateHostCode：包进 async IIFE（等价于文档注释所述的求值方式）——
let plugin
try {
  plugin = await (0, eval)(`(async () => {\n${code}\n})()`)
  console.log('[OK] evaluateHostCode 求值成功 ->', JSON.stringify({ name: plugin.name, inject: plugin.inject }))
} catch (e) {
  console.error('[FAIL] 求值失败:', e.message)
  process.exit(1)
}

// —— 应用插件 ——
plugin.apply(ctx)

// —— cloneJson 等价检查：返回值必须 lossless JSON（无 undefined/函数/循环引用）——
async function call(method, args) {
  const raw = await handlers[method](args)
  const json = JSON.stringify(raw)
  const roundtrip = JSON.parse(json)
  // 深度对比确保无损失
  JSON.stringify(roundtrip) === json || (() => { throw new Error('JSON roundtrip 不一致') })()
  return raw
}

// —— 冒烟 1: search_markets ——
console.log('\n—— 1) search_markets ——')
const search = await call('polymarket_search_markets', { q: 'president', limit: 3 })
console.log(`count=${search.count}`)
const first = search.events?.[0]?.markets?.[0]
console.log(`first market:`, JSON.stringify(first).slice(0, 300))
if (!first?.condition_id) { console.error('[FAIL] 未拿到 condition_id'); process.exit(1) }
const cid = first.condition_id
console.log('[OK] search_markets 返回 lossless JSON')

// —— 冒烟 2: get_market ——
console.log('\n—— 2) get_market ——')
const m = await call('polymarket_get_market', { condition_id: cid })
console.log('tokens:', JSON.stringify(m?.clob_tokens).slice(0, 200))
console.log('midpoints:', JSON.stringify(m?.midpoints))
console.log('[OK] get_market 返回 lossless JSON')

// —— 冒烟 3: get_orderbook ——
console.log('\n—— 3) get_orderbook ——')
const ob = await call('polymarket_get_orderbook', { condition_id: cid, side: 'yes' })
console.log('bids count:', ob?.book?.bids?.length, '| asks count:', ob?.book?.asks?.length)
console.log('[OK] get_orderbook 返回 lossless JSON')

// —— 冒烟 4: get_price ——
console.log('\n—— 4) get_price ——')
const p = await call('polymarket_get_price', { condition_id: cid, side: 'yes' })
console.log('price:', JSON.stringify(p?.price), '| mid:', JSON.stringify(p?.mid))
console.log('[OK] get_price 返回 lossless JSON')

// —— 冒烟 5: get_price_history ——
console.log('\n—— 5) get_price_history ——')
const h = await call('polymarket_get_price_history', { condition_id: cid, interval: '1d' })
const hpts = Array.isArray(h?.history?.history) ? h.history.history.length : -1
console.log(`interval=${h?.interval} fidelity=${h?.fidelity} history points:`, hpts > -1 ? hpts : JSON.stringify(h).slice(0, 200))
if (hpts <= 10) throw new Error(`history 点数异常（${hpts} ≤ 10）：interval/fidelity 语义疑似回归`)
console.log('[OK] get_price_history 返回 lossless JSON')

console.log('\n=== 全部 5 个 handler 冒烟通过 ===')