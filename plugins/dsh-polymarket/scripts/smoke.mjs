// headless 冒烟验证：确认 dsh-polymarket 插件在 cordis Context 中注册 5 个工具，
// 并串真实 Polymarket API 跑通 搜索→详情→订单簿→价格→历史 全链路。
// 运行方式：node --experimental-vm-modules smoke.mjs（在插件根目录，node_modules 已有 cordis junction）
import { Context } from 'cordis'
import { apply, inject, name } from '../lib/index.js'

const registered = []
class MockTools {
  register(def) {
    registered.push(def)
    return () => {}
  }
}

const ctx = new Context()
ctx.provide('tools', new MockTools())
apply(ctx, { gammaBase: 'https://gamma-api.polymarket.com', clobBase: 'https://clob.polymarket.com', timeoutMs: 10000 })

console.log('=== 注册验证 ===')
console.log('name:', name)
console.log('inject:', JSON.stringify(inject))
console.log('registered tools:', registered.map((t) => t.name).join(', '))

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))

// 全链路：搜索 → 第一个市场 → 详情 → 订单簿 → 价格 → 历史
async function runChain() {
  console.log('\n=== 真实 API 全链路 ===')
  // 1. 搜索（用当前活跃主题，命中旧市场会无订单簿）
  const search = await byName['polymarket_search_markets'].execute({ q: '2026 midterm', limit: 10 })
  const parsed = JSON.parse(search)
  const events = parsed.events ?? []
  const markets = events.flatMap((e) => e.markets ?? [])
  console.log(`[search] ${events.length} 个事件, 展平 ${markets.length} 个市场`)

  // 2-5. 遍历市场，找到订单簿/价格/历史均活跃的那个
  let chainDone = false
  for (const first of markets) {
    if (!first.condition_id) continue
    console.log(`\n[尝试] ${first.question} (${first.condition_id})`)
    try {
      // 详情
      const detail = JSON.parse(await byName['polymarket_get_market'].execute({ condition_id: first.condition_id }))
      const q = detail.gamma?.question ?? detail.market ?? '?'
      const vol = detail.gamma?.volume ?? '?'
      console.log(`[detail] ${q} | 规模: ${vol}`)

      // 订单簿（CLOB /book 返回 bids/asks）
      const book = JSON.parse(await byName['polymarket_get_orderbook'].execute({ condition_id: first.condition_id, side: 'yes' }))
      const bids = (book.book?.bids ?? []).length
      const asks = (book.book?.asks ?? []).length
      console.log(`[orderbook] yes: ${bids} 买 / ${asks} 卖`)

      // 价格（CLOB /midpoint 返回 mid 字段）
      const price = JSON.parse(await byName['polymarket_get_price'].execute({ condition_id: first.condition_id }))
      console.log(`[price] mid: ${price.midpoint?.mid ?? price.price?.price ?? '?'}`)

      // 历史
      const hist = JSON.parse(await byName['polymarket_get_price_history'].execute({ condition_id: first.condition_id, interval: '1d' }))
      console.log(`[history] 点数: ${(hist.history?.history ?? []).length}`)

      chainDone = true
      break
    } catch (e) {
      console.log(`[跳过] ${e.message.slice(0, 120)}`)
    }
  }
  if (!chainDone) throw new Error('所有候选市场均无活跃订单簿，无法完成链路')

  console.log('\n=== 全链路通过 ===')
}

runChain().catch((e) => {
  console.error('\n=== 全链路失败 ===')
  console.error(e.message)
  process.exit(1)
})
