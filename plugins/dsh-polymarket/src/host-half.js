/**
 * dsh-polymarket — host 半（动态插件宿主代码）。
 *
 * 用途：作为 cordis_define 的 `code.host` 传入（DSH 动态插件机制）。求值时宿主把它包进
 * `(async () => { ... })()`，因此本文件顶层必须 `return` 插件对象。
 *
 * 形态约束（对照 cordis-host-runner 源码确认）：
 *  - 必须对象形式 `{ name, inject: ['web'], apply(ctx) }` —— 函数形式会被 guardedPlugin
 *    转成 {name, apply} 丢失 inject，ctx.web 属性访问将被沙箱白名单拒绝；
 *  - `apply(ctx)` 内通过全局 `harness.handle(method, fn)` 注册 RPC handler，宿主
 *    normalizeHandler 包装为 `async (args) => cloneJson(await fn(args))`，因此 handler
 *    返回必须是 lossless JSON（拒绝 undefined/Date/Map/Set/函数/类实例；undefined 值
 *    需手动规整为 null）；
 *  - 网络走 `ctx.web.fetch`：`{ url } → { statusCode, body: {kind, content}, truncated }`，
 *    JSON/CSV 均归类 kind='text'，需手动 `JSON.parse(body.content)`；非 2xx 是结果不是异常。
 *
 * 端点参考（与 src/index.ts 静态插件一致）：
 *  - Gamma `/public-search`（搜索）、`/markets?condition_ids=`（市场详情）
 *  - CLOB `/markets/{conditionId}`（conditionId→token_id 转换）、`/book`、`/price`、
 *    `/midpoint`、`/prices-history`
 */
return {
  name: 'dsh-polymarket',
  inject: ['web'],
  apply(ctx) {
    const GAMMA_BASE = 'https://gamma-api.polymarket.com'
    const CLOB_BASE = 'https://clob.polymarket.com'

    /**
     * GET + JSON 解析。非 2xx 抛错（含状态码与 URL）；响应体归 text 后手动 parse。
     * ctx.web.fetch 非 2xx 返回的是结果不是异常，必须显式判定。
     */
    async function fetchJson(base, path) {
      let res
      try {
        res = await ctx.web.fetch({ url: base + path })
      } catch (err) {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        throw new Error(`Polymarket API 请求失败 ${base + path}: ${reason}（受限网络需配置代理，参见 DEV.md「网络前提」）`)
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`Polymarket API ${res.statusCode} ${base + path}`)
      }
      if (res.body.kind !== 'text') {
        throw new Error(`Polymarket API 非文本响应 ${res.statusCode} ${base + path} (kind=${res.body.kind})`)
      }
      return JSON.parse(res.body.content)
    }

    /** conditionId → 十进制 token_id（按 yes/no 侧，CLOB /markets/{conditionId} → tokens[].token_id）。 */
    async function tokenIdFor(conditionId, side) {
      const data = await fetchJson(CLOB_BASE, `/markets/${encodeURIComponent(conditionId)}`)
      const tokens = Array.isArray(data?.tokens) ? data.tokens : []
      const want = side === 'yes' ? 'yes' : 'no'
      const token = tokens.find((t) => String(t?.outcome).toLowerCase() === want)
      if (!token) {
        throw new Error(
          `Polymarket: conditionId ${conditionId} 无 ${side} 侧 token（tokens=${tokens.map((t) => t?.outcome).join(',') || '空'}）`,
        )
      }
      return token.token_id
    }

    /** cloneJson 拒绝 undefined，统一规整为 null。 */
    const clean = (v) => (v === undefined ? null : v)

    // 1) 搜索市场（Gamma /public-search）
    harness.handle('polymarket_search_markets', async (args = {}) => {
      const q = String(args.q ?? '')
      const limit = Number(args.limit ?? 5)
      if (!q) throw new Error('polymarket_search_markets 需要非空 q')
      const data = await fetchJson(GAMMA_BASE, `/public-search?q=${encodeURIComponent(q)}&limit=${limit}`)
      const events = Array.isArray(data?.events) ? data.events : []
      return {
        query: q,
        count: events.length,
        events: events.map((e) => ({
          title: clean(e?.title),
          event_id: clean(e?.id),
          markets: Array.isArray(e?.markets)
            ? e.markets.map((m) => ({
                condition_id: clean(m?.conditionId),
                question: clean(m?.question),
                outcome_prices: clean(m?.outcomePrices),
                volume: clean(m?.volume),
              }))
            : [],
        })),
      }
    })

    // 2) 市场详情（Gamma 元数据 + CLOB tokens + 双方中点价）
    harness.handle('polymarket_get_market', async (args = {}) => {
      const cid = String(args.condition_id ?? '')
      if (!cid) throw new Error('polymarket_get_market 需要 condition_id')
      const gamma = await fetchJson(GAMMA_BASE, `/markets?condition_ids=${encodeURIComponent(cid)}`)
      const clob = await fetchJson(CLOB_BASE, `/markets/${encodeURIComponent(cid)}`)
      const tokens = Array.isArray(clob?.tokens) ? clob.tokens : []
      const midpoints = {}
      for (const t of tokens) {
        try {
          // CLOB /midpoint 返回结构为 { mid: string }，不是 { midpoint }
          const mp = await fetchJson(CLOB_BASE, `/midpoint?token_id=${t.token_id}`)
          midpoints[String(t.outcome)] = clean(mp?.mid)
        } catch { /* 单侧中点缺失不阻断整体 */ }
      }
      return {
        gamma: Array.isArray(gamma) ? (gamma[0] ?? null) : null,
        clob_tokens: tokens.map((t) => ({ outcome: clean(t?.outcome), token_id: clean(t?.token_id) })),
        midpoints,
      }
    })

    // 3) 订单簿（CLOB /book，按 yes/no 侧查深度）
    harness.handle('polymarket_get_orderbook', async (args = {}) => {
      const cid = String(args.condition_id ?? '')
      const side = String(args.side ?? 'yes') === 'no' ? 'no' : 'yes'
      if (!cid) throw new Error('polymarket_get_orderbook 需要 condition_id')
      const tokenId = await tokenIdFor(cid, side)
      const book = await fetchJson(CLOB_BASE, `/book?token_id=${tokenId}&side=${side === 'yes' ? 'buy' : 'sell'}`)
      return { condition_id: cid, side, book }
    })

    // 4) 最新价格（CLOB /price + /midpoint）
    harness.handle('polymarket_get_price', async (args = {}) => {
      const cid = String(args.condition_id ?? '')
      const side = String(args.side ?? 'yes') === 'no' ? 'no' : 'yes'
      if (!cid) throw new Error('polymarket_get_price 需要 condition_id')
      const tokenId = await tokenIdFor(cid, side)
      const price = await fetchJson(CLOB_BASE, `/price?token_id=${tokenId}&side=${side === 'yes' ? 'buy' : 'sell'}`)
      // CLOB /midpoint 返回结构为 { mid: string }
      const midpoint = await fetchJson(CLOB_BASE, `/midpoint?token_id=${tokenId}`)
      return { condition_id: cid, side, price, mid: clean(midpoint?.mid) }
    })

    // 5) 历史价格（CLOB /prices-history；interval=回看时间窗，fidelity=K线粒度）
    harness.handle('polymarket_get_price_history', async (args = {}) => {
      const cid = String(args.condition_id ?? '')
      if (!cid) throw new Error('polymarket_get_price_history 需要 condition_id')
      // 实测语义（2026-08-23）：interval 是回看窗口（1d=最近一天，all=全部历史），
      // fidelity 才是 K 线粒度；窗口配同尺寸 K 线只剩 1~2 点（旧 bug 根因）。
      const INTERVALS = new Set(['1h', '6h', '1d', '1w', 'all'])
      const interval = INTERVALS.has(args.interval) ? args.interval : '1d'
      const FIDELITY = { '1h': 5, '6h': 30, '1d': 60, '1w': 360, all: 1440 }
      const fidelity = args.fidelity === undefined ? FIDELITY[interval] : Number(args.fidelity)
      const tokenId = await tokenIdFor(cid, 'yes')
      const history = await fetchJson(
        CLOB_BASE,
        `/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`,
      )
      return { condition_id: cid, interval, fidelity, history }
    })
  },
}