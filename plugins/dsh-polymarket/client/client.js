/**
 * dsh-polymarket — 静态客户端面板（shell.overlay 浮动侧栏）。
 *
 * 与老的动态 cordis client-half.js 不同：本文件是【静态】客户端模块，
 * 通过 window.__ModuleLoader__.load({ id, factory }) 注册，直接由 Web 应用
 * 加载（无需 agent 运行、无需 pluginRunId）。
 *
 * 数据通道：浏览器直连 Polymarket Gamma（搜索/元数据）与 CLOB（价格/订单簿/
 * 历史）——两 API 均已验证 Access-Control-Allow-Origin: *。
 *
 * 落点：shell.overlay。右侧全高可拖宽面板，默认收起为边缘浮动按钮，
 * 点开即「并排查看」：默认热门榜（24h 成交量排序的活跃事件），可搜索收窄；
 * 点市场 → 详情（中间价 / 买卖盘 / 可切窗口的价格走势 + hover 十字线）。
 * 🎯 跟随会话：agent 调用本插件工具时，侧栏自动切到该查询/市场。
 * 开合/搜索词/自选/宽度/跟随开关均存 localStorage。
 */
window.__ModuleLoader__.load({
  id: 'dsh-polymarket',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useState, useEffect, useCallback, createElement: h } = React

    const GAMMA = 'https://gamma-api.polymarket.com'
    const CLOB = 'https://clob.polymarket.com'
    const LS_OPEN = 'dsh-poly-open'
    const LS_QUERY = 'dsh-poly-query'
    const LS_WATCH = 'dsh-poly-watch'
    const LS_WIDTH = 'dsh-poly-width'
    const LS_FOLLOW = 'dsh-poly-follow'
    const LIST_POLL_MS = 30000
    const DETAIL_POLL_MS = 15000
    const TREND_LIMIT = 10
    // 走势窗口 → K 线粒度（分钟）；语义与宿主 get_price_history 实测一致
    const WIN_FID = { '1h': 5, '1d': 60, '1w': 360, all: 1440 }
    const WIN_LABEL = { '1h': '近 1 小时', '1d': '近 24 小时', '1w': '近一周', all: '全部历史' }

    // ── 工具 ─────────────────────────────────────────────────────────────

    async function fetchJson(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`)
      return res.json()
    }

    function yesPrice(m) {
      try {
        const p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices || []
        return typeof p[0] === 'number' ? p[0] : Number(p[0])
      } catch {
        return NaN
      }
    }

    // 解析一个市场的双方标签与价格（outcomes 可能是 JSON 字符串或数组；
    // 体育市场是队名而非 Yes/No——显示必须用真实标签）。
    function marketSides(m) {
      const parse = (v) => {
        if (typeof v === 'string') { try { return JSON.parse(v) } catch { return [] } }
        return Array.isArray(v) ? v : []
      }
      const labels = parse(m.outcomes).map((x) => String(x))
      const prices = parse(m.outcomePrices).map((x) => Number(x))
      const l0 = labels[0] || ''
      const l1 = labels[1] || ''
      return {
        l0, l1,
        p0: Number.isFinite(prices[0]) ? prices[0] : NaN,
        p1: Number.isFinite(prices[1]) ? prices[1] : NaN,
        closed: m.closed === true,
      }
    }

    const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '')

    function fmtPct(v) {
      const n = Number(v)
      return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '?'
    }

    function fmtVol(v) {
      const n = Number(v)
      if (!Number.isFinite(n)) return '?'
      if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
      return String(Math.round(n))
    }

    // 事件内挑「值得看」的市场：跳过已结算（closed 或价格 <2%/>98%），
    // 按 24h 量降序取前 3；事件全死返回 []（整个事件不进热门榜）。
    function eventMarkets(e) {
      const all = (e.markets || [])
        .map((m) => {
          const s = marketSides(m)
          return {
            question: m.question || '',
            condition_id: m.conditionId || m.condition_id || '',
            slug: m.slug || '',
            label0: s.l0,
            label1: s.l1,
            p0: s.p0,
            p1: s.p1,
            yes: s.p0,
            volume: m.volume ?? 0,
            v24: m.volume24hr ?? 0,
            closed: s.closed,
          }
        })
        .filter((m) => m.condition_id)
      const live = all.filter((m) => !m.closed && Number.isFinite(m.p0) && m.p0 > 0.02 && m.p0 < 0.98)
      return live.sort((a, b) => b.v24 - a.v24).slice(0, 3)
    }

    function lsGet(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : v } catch { return fallback }
    }
    function lsSet(key, value) {
      try { localStorage.setItem(key, value) } catch { /* 隐私模式等场景忽略 */ }
    }

    // ── Polymarket 官方标志（favicon 93×116 复刻：四个三角的折纸结构）──
    // fill=currentColor 随主题前景色，明暗主题都成立，无外部资源依赖。
    function PolyIcon({ size = 14 }) {
      return h('svg', {
        width: size, height: Math.round(size * 87 / 93), viewBox: '0 29 93 87',
        fill: 'currentColor', 'aria-hidden': 'true', style: { verticalAlign: '-0.125em' },
      },
        h('path', { d: 'M0 29 L93 29 L46.5 58 Z' }),
        h('path', { d: 'M0 58 L46.5 58 L0 87 Z' }),
        h('path', { d: 'M93 58 L46.5 58 L93 87 Z' }),
        h('path', { d: 'M0 87 L93 87 L46.5 116 Z' }),
      )
    }

    // ── 跟随会话：从当前会话快照提取最近一次 polymarket 工具调用 ─────────
    // 数据通路：ctx.sessions.currentProvideInfo（HostObservable）→ hooks.session
    // （会话快照 HostObservable，nodes[].blocks[] 里 kind='tool-call' 带
    // name/argsRaw）。去重靠 key，快照每次事件推送都会重发。
    const followState = { key: null, value: null, listeners: new Set() }

    function emitFollow(v) {
      for (const fn of followState.listeners) {
        try { fn(v) } catch { /* 单个订阅者异常不阻断 others */ }
      }
    }

    function extractFollow(snapshot) {
      const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : []
      let found = null
      for (const node of nodes) {
        if (!node || node.kind !== 'assistant') continue
        for (const b of node.blocks || []) {
          if (!b || b.kind !== 'tool-call' || typeof b.name !== 'string' || b.name.indexOf('polymarket_') !== 0) continue
          const raw = typeof b.argsRaw === 'string' ? b.argsRaw : ''
          let q = ''
          let cid = ''
          try {
            const a = JSON.parse(raw)
            q = a && a.q ? String(a.q) : ''
            cid = a && a.condition_id ? String(a.condition_id) : ''
          } catch {
            const mq = raw.match(/"q"\s*:\s*"([^"]+)"/); if (mq) q = mq[1]
            const mc = raw.match(/"condition_id"\s*:\s*"([^"]+)"/); if (mc) cid = mc[1]
          }
          found = { tool: b.name, q, cid }
        }
      }
      return found
    }

    function wireFollow(ctx) {
      const info$ = ctx.sessions && ctx.sessions.currentProvideInfo
      if (!info$ || typeof info$.subscribe !== 'function') return () => {}
      let unsubSession = () => {}
      const observeInfo = () => {
        if (typeof unsubSession === 'function') unsubSession()
        unsubSession = () => {}
        const info = info$.getSnapshot()
        const obs = info && info.hooks && info.hooks.session
        if (!obs || typeof obs.getSnapshot !== 'function') return
        const handle = () => {
          const found = extractFollow(obs.getSnapshot())
          if (!found) return
          const key = found.tool + '|' + found.q + found.cid
          if (key === followState.key) return
          followState.key = key
          followState.value = found
          emitFollow(found)
        }
        handle()
        if (typeof obs.subscribe === 'function') unsubSession = obs.subscribe(handle)
      }
      const unsubInfo = info$.subscribe(observeInfo)
      observeInfo()
      return () => { if (typeof unsubInfo === 'function') unsubInfo(); unsubSession() }
    }

    // ── Sparkline：纯 SVG 折线 + hover 十字线（价格/时间随动）─────────────

    function Sparkline({ series, width = 320, height = 56 }) {
      const [hover, setHover] = useState(null)
      const pts = (series || []).map((x) => ({ t: Number(x.t), p: Number(x.p) })).filter((x) => Number.isFinite(x.p))
      if (pts.length < 2) return h('div', { className: 'dsh-poly-note' }, '历史点数不足')
      const min = Math.min(...pts.map((x) => x.p))
      const max = Math.max(...pts.map((x) => x.p))
      const span = max - min || 1
      const stepX = width / (pts.length - 1)
      const y = (v) => 4 + (height - 8) * (1 - (v - min) / span)
      const path = pts.map((x, i) => `${(i * stepX).toFixed(1)},${y(x.p).toFixed(1)}`).join(' ')
      const up = pts[pts.length - 1].p >= pts[0].p
      const color = up ? 'var(--dsh-poly-up, #34d399)' : 'var(--dsh-poly-down, #f87171)'
      const onMove = (e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        if (!rect.width) return
        const x = ((e.clientX - rect.left) / rect.width) * width
        setHover(Math.max(0, Math.min(pts.length - 1, Math.round(x / stepX))))
      }
      const timeStr = (t) => {
        if (!Number.isFinite(t)) return ''
        const d = new Date(t * 1000)
        const p2 = (n) => String(n).padStart(2, '0')
        return `${p2(d.getHours())}:${p2(d.getMinutes())}`
      }
      const hv = hover != null ? pts[hover] : null
      const hx = hover != null ? hover * stepX : 0
      const anchorEnd = hover != null && hover > (pts.length - 1) / 2
      return h('svg', {
        width, height, viewBox: `0 0 ${width} ${height}`, className: 'dsh-poly-spark',
        role: 'img', 'aria-label': `走势 ${fmtPct(min)} ~ ${fmtPct(max)}`,
        onMouseMove: onMove, onMouseLeave: () => setHover(null),
      },
        h('polyline', { points: path, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
        h('circle', { cx: (pts.length - 1) * stepX, cy: y(pts[pts.length - 1].p), r: 2.5, fill: color }),
        h('text', { x: 2, y: 10, fill: 'currentColor', opacity: .55, 'font-size': 9 }, fmtPct(min)),
        h('text', { x: width - 2, y: 10, 'text-anchor': 'end', fill: 'currentColor', opacity: .55, 'font-size': 9 }, fmtPct(max)),
        hv ? h('g', { className: 'dsh-poly-cross', pointerEvents: 'none' },
          h('line', { x1: hx, y1: 2, x2: hx, y2: height - 2, stroke: 'currentColor', opacity: .3, 'stroke-dasharray': '3 3' }),
          h('circle', { cx: hx, cy: y(hv.p), r: 3, fill: color, stroke: 'var(--color-bg-2,#1b1e26)', 'stroke-width': 1.5 }),
          h('text', { x: anchorEnd ? hx - 6 : hx + 6, y: 12, 'text-anchor': anchorEnd ? 'end' : 'start', 'font-size': 10, fill: color, fontWeight: 600 }, fmtPct(hv.p)),
          h('text', { x: anchorEnd ? hx - 6 : hx + 6, y: 24, 'text-anchor': anchorEnd ? 'end' : 'start', 'font-size': 9, fill: 'currentColor', opacity: .55 }, timeStr(hv.t)),
        ) : null,
      )
    }

    // ── 市场详情：token 解析 → midpoint / book / history 并取 ─────────────

    function MarketDetail({ market, onBack, watched, onToggleWatch }) {
      const [state, setState] = useState({ status: 'loading', error: null, mid: null, history: [], book: null, at: null })
      const [win, setWin] = useState('1d')

      const load = useCallback(async (signal) => {
        try {
          setState((s) => ({ ...s, status: 'loading', error: null }))
          // conditionId → 第一 outcome 的 token（体育等市场没有 yes 侧，用 tokens[0]）
          const meta = await fetchJson(`${CLOB}/markets/${encodeURIComponent(market.condition_id)}`)
          const tokens = Array.isArray(meta && meta.tokens) ? meta.tokens : []
          const tk = tokens[0]
          if (!tk) throw new Error('该市场无 token（可能已结算/关闭）')
          const tid = tk.token_id
          const [mid, hist, book] = await Promise.all([
            fetchJson(`${CLOB}/midpoint?token_id=${tid}`).catch(() => null),
            fetchJson(`${CLOB}/prices-history?market=${tid}&interval=${win}&fidelity=${WIN_FID[win]}`).catch(() => null),
            fetchJson(`${CLOB}/book?token_id=${tid}&side=buy`).catch(() => null),
          ])
          if (signal.aborted) return
          const series = hist && Array.isArray(hist.history)
            ? hist.history.map((x) => ({ t: x.t, p: Number(x.p) })) : []
          setState({
            status: 'ok', error: null,
            mid: mid && mid.mid != null ? Number(mid.mid) : null,
            history: series,
            book: book && Array.isArray(book.bids) && Array.isArray(book.asks) ? book : null,
            at: new Date(),
          })
        } catch (err) {
          if (signal.aborted) return
          setState((s) => ({ ...s, status: 'error', error: String((err && err.message) || err) }))
        }
      }, [market.condition_id, win])

      useEffect(() => {
        const ac = new AbortController()
        load(ac.signal)
        const timer = setInterval(() => load(ac.signal), DETAIL_POLL_MS)
        return () => { ac.abort(); clearInterval(timer) }
      }, [load])

      const bestBid = state.book && state.book.bids.length ? Number(state.book.bids[0].price) : null
      const bestAsk = state.book && state.book.asks.length ? Number(state.book.asks[state.book.asks.length - 1].price) : null
      const bidDepth = state.book ? state.book.bids.length : 0
      const askDepth = state.book ? state.book.asks.length : 0

      return h('div', { className: 'dsh-poly-detail' },
        h('div', { className: 'dsh-poly-detail-head' },
          h('button', { className: 'dsh-poly-back', onClick: onBack, title: '返回列表' }, '‹ 返回'),
          h('span', { className: 'dsh-poly-detail-head-r' },
            h('button', {
              className: 'dsh-poly-star' + (watched ? ' on' : ''), title: watched ? '取消自选' : '加入自选',
              onClick: () => onToggleWatch(market),
            }, watched ? '★' : '☆'),
            state.at ? h('span', { className: 'dsh-poly-vol', title: state.at.toLocaleString() },
              `${state.at.getHours().toString().padStart(2, '0')}:${state.at.getMinutes().toString().padStart(2, '0')} 更新`) : null),
        ),
        h('div', { className: 'dsh-poly-q' }, market.question),
        state.status === 'loading' && !state.mid ? h('div', { className: 'dsh-poly-loading' }, '加载详情…') : null,
        state.status === 'error' ? h('div', { className: 'dsh-poly-err' }, '详情加载失败：' + state.error) : null,
        state.status === 'ok' ? h('div', null,
          h('div', { className: 'dsh-poly-sides dsh-poly-sides-detail' },
            h('span', { className: 'dsh-poly-yes' }, cut(market.label0 || 'Yes', 16) + ' ' + fmtPct(state.mid)),
            market.label1 && Number.isFinite(market.p1)
              ? h('span', { className: 'dsh-poly-side1' }, cut(market.label1, 16) + ' ' + fmtPct(market.p1)) : null,
          ),
          h('div', { className: 'dsh-poly-bar dsh-poly-bar-detail' },
            h('div', {
              className: 'dsh-poly-bar-fill',
              style: { width: (state.mid != null && Number.isFinite(state.mid) ? Math.max(0, Math.min(1, state.mid)) * 100 : 0) + '%' },
            })),
          h('div', { className: 'dsh-poly-vol' },
            state.mid != null ? `中间价 · 买一 ${fmtPct(bestBid)} · 卖一 ${fmtPct(bestAsk)} · 盘口 ${bidDepth}/${askDepth} 档` : ''),
          h('div', { className: 'dsh-poly-win', role: 'tablist', 'aria-label': '走势时间窗' },
            Object.keys(WIN_FID).map((w) =>
              h('button', {
                key: w, className: w === win ? 'on' : '', role: 'tab', 'aria-selected': w === win,
                onClick: () => setWin(w),
              }, w))),
          h('div', { className: 'dsh-poly-spark-wrap' },
            h(Sparkline, { series: state.history }),
            h('div', { className: 'dsh-poly-vol' }, `${WIN_LABEL[win]} · ${state.history.length} 点 · ${WIN_FID[win]} 分钟线 · 悬停看价格`)),
        ) : null,
        market.slug
          ? h('a', {
              className: 'dsh-poly-link', href: `https://polymarket.com/market/${market.slug}`,
              target: '_blank', rel: 'noopener noreferrer',
            }, '在 Polymarket 打开 ↗')
          : null,
        h('div', { className: 'dsh-poly-vol', style: { marginTop: 'auto', paddingTop: 8 } },
          'condition ' + String(market.condition_id).slice(0, 18) + '… · CLOB 直连'),
      )
    }

    // ── 主面板：开合 / 搜索 / 列表轮询 / 详情切换 ──────────────────────────

    function MarketPanel() {
      const [open, setOpen] = useState(() => lsGet(LS_OPEN, '0') === '1')
      const [query, setQuery] = useState(() => lsGet(LS_QUERY, ''))
      const [input, setInput] = useState(() => lsGet(LS_QUERY, ''))
      const [state, setState] = useState({ status: 'idle', events: [], error: null, at: null })
      const [detail, setDetail] = useState(null)
      // 面板宽度（左缘拖拽，300~720px，持久）
      const [width, setWidth] = useState(() => {
        const n = Number(lsGet(LS_WIDTH, '360'))
        return Number.isFinite(n) && n >= 300 && n <= 720 ? n : 360
      })
      // 🎯 跟随会话：agent 调 polymarket 工具时侧栏自动跟随；手动搜索即暂停
      const [follow, setFollow] = useState(() => lsGet(LS_FOLLOW, '1') === '1')
      // 自选（localStorage 持久）：[{condition_id, question, slug}]；价格随 30s 轮询批量刷新
      const [watch, setWatch] = useState(() => {
        try {
          const v = JSON.parse(lsGet(LS_WATCH, '[]'))
          return Array.isArray(v) ? v.filter((m) => m && m.condition_id) : []
        } catch { return [] }
      })
      const [watchQuotes, setWatchQuotes] = useState({})

      const watchIds = watch.map((m) => m.condition_id).join(',')
      const isWatched = (m) => watch.some((w) => w.condition_id === m.condition_id)
      const toggleWatch = (m) => {
        setWatch((list) => {
          const next = isWatched(m)
            ? list.filter((w) => w.condition_id !== m.condition_id)
            : [...list, {
                condition_id: m.condition_id, question: m.question || '', slug: m.slug || '',
                label0: m.label0 || '', label1: m.label1 || '',
                p0: Number.isFinite(m.p0) ? m.p0 : m.yes, p1: m.p1,
              }]
          lsSet(LS_WATCH, JSON.stringify(next))
          return next
        })
      }

      const search = useCallback(async (q, signal) => {
        if (!q) return
        setState((s) => ({ ...s, status: 'loading', error: null }))
        try {
          const data = await fetchJson(`${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit=8`)
          if (signal && signal.aborted) return
            const events = (data.events || []).map((e) => ({
            title: e.title || '',
            icon: e.icon || '',
            markets: (e.markets || []).map((m) => {
              const s = marketSides(m)
              return {
                question: m.question || '',
                condition_id: m.conditionId || m.condition_id || '',
                slug: m.slug || '',
                label0: s.l0, label1: s.l1, p0: s.p0, p1: s.p1,
                yes: s.p0,
                volume: m.volume ?? 0,
                v24: m.volume24hr ?? 0,
                closed: s.closed,
              }
            }).filter((m) => m.condition_id && !m.closed),
          }))
          setState({ status: 'ok', events, error: null, at: new Date() })
        } catch (err) {
          if (signal && signal.aborted) return
          setState((s) => ({ ...s, status: 'error', error: String((err && err.message) || err) }))
        }
      }, [])

      // 默认界面：24h 成交量排序的活跃事件（热门榜），打开即见，无需搜索
      const trending = useCallback(async (signal) => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        try {
          const data = await fetchJson(`${GAMMA}/events?limit=${TREND_LIMIT}&active=true&closed=false&order=volume24hr&ascending=false`)
          if (signal && signal.aborted) return
          const events = (Array.isArray(data) ? data : []).map((e) => ({
            title: e.title || '',
            icon: e.icon || '',
            v24: e.volume24hr ?? 0,
            markets: eventMarkets(e),
          })).filter((e) => e.markets.length > 0)
          setState({ status: 'ok', events, error: null, at: new Date() })
        } catch (err) {
          if (signal && signal.aborted) return
          setState((s) => ({ ...s, status: 'error', error: String((err && err.message) || err) }))
        }
      }, [])

      // 打开即加载：有搜索词走搜索，没有走热门榜；均 30s 轮询；自选价格同轮批量刷新
      useEffect(() => {
        if (!open) return
        const ac = new AbortController()
        const loadWatch = async () => {
          if (!watchIds) { setWatchQuotes({}); return }
          try {
            const data = await fetchJson(`${GAMMA}/markets?condition_ids=${encodeURIComponent(watchIds)}`)
            if (ac.signal.aborted) return
            const quotes = {}
            for (const m of Array.isArray(data) ? data : []) {
              if (m && m.conditionId) {
                const s = marketSides(m)
                quotes[m.conditionId] = { p0: s.p0, p1: s.p1 }
              }
            }
            setWatchQuotes(quotes)
          } catch { /* 自选刷新失败不打断主列表 */ }
        }
        const load = () => {
          if (query) search(query, ac.signal); else trending(ac.signal)
          loadWatch()
        }
        load()
        const timer = setInterval(load, LIST_POLL_MS)
        return () => { ac.abort(); clearInterval(timer) }
      }, [open, query, search, trending, watchIds])

      const toggle = () => {
        setOpen((v) => { lsSet(LS_OPEN, v ? '0' : '1'); return !v })
      }
      const pauseFollow = () => {
        if (follow) { setFollow(false); lsSet(LS_FOLLOW, '0') }
      }
      const submit = (e) => {
        e.preventDefault()
        const q = input.trim()
        setDetail(null)
        pauseFollow()
        if (!q) {
          setQuery('')
          lsSet(LS_QUERY, '')
          return
        }
        setQuery(q)
        lsSet(LS_QUERY, q)
      }

      // 左缘拖宽：document 级 move/up 跟踪，松手时才写 localStorage
      const startDrag = (e) => {
        e.preventDefault()
        let w = width
        const mv = (ev) => {
          w = Math.max(300, Math.min(720, window.innerWidth - ev.clientX))
          setWidth(w)
        }
        const up = () => {
          document.removeEventListener('mousemove', mv)
          document.removeEventListener('mouseup', up)
          lsSet(LS_WIDTH, String(Math.round(w)))
        }
        document.addEventListener('mousemove', mv)
        document.addEventListener('mouseup', up)
      }

      // 跟随事件：search → 切搜索词；带 condition_id 的工具 → 拉名称后进详情
      useEffect(() => {
        if (!follow) return
        const onFollow = (v) => {
          if (v.q) {
            setQuery(v.q); setInput(v.q); lsSet(LS_QUERY, v.q); setDetail(null)
          } else if (v.cid) {
            fetchJson(`${GAMMA}/markets?condition_ids=${encodeURIComponent(v.cid)}`)
              .then((data) => {
                const m = Array.isArray(data) ? data[0] : null
                setDetail({
                  question: (m && m.question) || ('condition ' + v.cid.slice(0, 12) + '…'),
                  condition_id: v.cid,
                  slug: (m && m.slug) || '',
                  yes: m ? yesPrice(m) : NaN,
                })
              })
              .catch(() => setDetail({ question: 'condition ' + v.cid.slice(0, 12) + '…', condition_id: v.cid, slug: '', yes: NaN }))
          }
        }
        followState.listeners.add(onFollow)
        return () => { followState.listeners.delete(onFollow) }
      }, [follow])

      // 收起态：边缘浮动按钮
      if (!open) {
        return h('button', {
          className: 'dsh-poly-fab', onClick: toggle,
          title: 'Polymarket 行情侧栏',
        }, h(PolyIcon, { size: 13 }), ' 行情')
      }

      // 市场卡片：真实双方标签 + 概率条；整卡点击进详情，右上角 ☆ 自选
      const renderMarket = (m, key) => {
        const p0 = Number.isFinite(m.p0) ? m.p0 : m.yes
        const label0 = m.label0 || 'Yes'
        return h('div', {
          className: 'dsh-poly-item', key, role: 'button', tabIndex: 0,
          onClick: () => setDetail(m),
          onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(m) } },
          title: m.condition_id,
        },
          h('div', { className: 'dsh-poly-q' }, m.question),
          h('div', { className: 'dsh-poly-sides' },
            h('span', { className: 'dsh-poly-yes' }, cut(label0, 14) + ' ' + fmtPct(p0)),
            m.label1 && Number.isFinite(m.p1)
              ? h('span', { className: 'dsh-poly-side1' }, cut(m.label1, 14) + ' ' + fmtPct(m.p1)) : null,
            h('button', {
              className: 'dsh-poly-star' + (isWatched(m) ? ' on' : ''),
              title: isWatched(m) ? '取消自选' : '加入自选',
              onClick: (e) => { e.stopPropagation(); toggleWatch(m) },
            }, isWatched(m) ? '★' : '☆'),
          ),
          h('div', { className: 'dsh-poly-bar', title: cut(label0, 20) + ' 概率' },
            h('div', {
              className: 'dsh-poly-bar-fill',
              style: { width: (Number.isFinite(p0) ? Math.max(0, Math.min(1, p0)) * 100 : 0) + '%' },
            })),
        )
      }

      return h('div', { className: 'dsh-poly-panel', style: { width: width + 'px' } },
        h('div', { className: 'dsh-poly-drag', onMouseDown: startDrag, title: '拖拽调整宽度' }),
        h('div', { className: 'dsh-poly-header' },
          h('span', { className: 'dsh-poly-mode' },
            h(PolyIcon, { size: 12 }), ' ',
            query ? '#' + query : '热门榜'),
          h('span', { className: 'dsh-poly-header-r' },
            h('button', {
              className: 'dsh-poly-follow' + (follow ? ' on' : ''),
              title: follow ? '跟随中：agent 查行情时侧栏自动同步（点击暂停）' : '已暂停跟随（点击开启）',
              'aria-pressed': follow,
              onClick: () => { setFollow(!follow); lsSet(LS_FOLLOW, follow ? '0' : '1') },
            }, '🎯'),
            query
              ? h('button', {
                  className: 'dsh-poly-clear', title: '清除搜索，回到热门榜',
                  onClick: () => { pauseFollow(); setQuery(''); setInput(''); lsSet(LS_QUERY, ''); setDetail(null) },
                }, '✕')
              : null,
            h('button', { className: 'dsh-poly-close', onClick: toggle, title: '收起' }, '›')),
        ),
        h('form', { className: 'dsh-poly-search', onSubmit: submit },
          h('input', {
            type: 'text', value: input, placeholder: '搜索主题；清空回车回热门…',
            onChange: (e) => setInput(e.target.value),
            'aria-label': 'Polymarket 搜索',
          }),
          h('button', { type: 'submit' }, '搜索'),
        ),
        detail
          ? h(MarketDetail, {
              market: detail, onBack: () => setDetail(null),
              watched: isWatched(detail), onToggleWatch: toggleWatch,
            })
          : h('div', { className: 'dsh-poly-list' },
              state.status === 'loading' && state.events.length === 0 ? h('div', { className: 'dsh-poly-loading' }, '加载中…') : null,
              state.status === 'error' ? h('div', { className: 'dsh-poly-err' }, '行情加载失败：' + state.error + '（受限网络需系统代理）') : null,
              state.status === 'ok' && state.events.length === 0 ? h('div', { className: 'dsh-poly-loading' }, '无结果') : null,
              watch.length > 0
                ? h('div', { className: 'dsh-poly-watch' },
                    h('div', { className: 'dsh-poly-watch-title' }, '★ 自选 · 30s 刷新'),
                    watch.map((m, i) => {
                      const q = watchQuotes[m.condition_id] || {}
                      return renderMarket({ ...m, p0: Number.isFinite(q.p0) ? q.p0 : m.p0, p1: Number.isFinite(q.p1) ? q.p1 : m.p1 }, 'w' + i)
                    }))
                : null,
              state.events.map((ev, i) =>
                h('div', { className: 'dsh-poly-event', key: i },
                  h('div', { className: 'dsh-poly-event-title' },
                    ev.icon ? h('img', { className: 'dsh-poly-eicon', src: ev.icon, alt: '', loading: 'lazy' }) : null,
                    h('span', { className: 'dsh-poly-etitle' }, ev.title || '—'),
                    ev.v24 ? h('span', { className: 'dsh-poly-v24', title: '24h 成交量' }, '24h ' + fmtVol(ev.v24)) : null),
                  ev.markets.map((m, j) => renderMarket(m, i + '-' + j)),
                ),
              ),
              state.at ? h('div', { className: 'dsh-poly-vol', style: { padding: '4px 2px' } },
                (query ? '#' + query : '热门榜') + ' · 30s 自动刷新') : null,
            ),
      )
    }

    // ── 样式：主题变量 + 安全回退 ─────────────────────────────────────────

    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-polymarket-style')) return
      const css = `
.dsh-poly-panel{position:fixed;top:0;right:0;height:100vh;width:360px;z-index:50;
  pointer-events:auto;display:flex;flex-direction:column;
  background:var(--color-bg-1,#14161c);color:var(--color-text-1,#e6e6e6);
  border-left:1px solid var(--color-border-1,#2a2e37);
  font:13px/1.5 system-ui,-apple-system,sans-serif;
  box-shadow:-8px 0 24px rgba(0,0,0,.35);}
.dsh-poly-header{padding:10px 12px;font-weight:600;border-bottom:1px solid var(--color-border-1,#2a2e37);display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dsh-poly-mode{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-poly-header-r{display:flex;align-items:center;gap:4px;flex-shrink:0;}
.dsh-poly-clear{background:none;border:none;color:inherit;font-size:13px;cursor:pointer;padding:0 4px;opacity:.7;}
.dsh-poly-clear:hover{opacity:1;}
.dsh-poly-v24{margin-left:8px;font-size:10px;font-weight:400;opacity:.55;font-variant-numeric:tabular-nums;}
.dsh-poly-close{background:none;border:none;color:inherit;font-size:18px;cursor:pointer;padding:0 4px;opacity:.7;}
.dsh-poly-close:hover{opacity:1;}
.dsh-poly-fab{position:fixed;top:64px;right:0;z-index:50;pointer-events:auto;cursor:pointer;
  background:var(--color-bg-2,#1b1e26);color:var(--color-text-1,#e6e6e6);
  border:1px solid var(--color-border-1,#2a2e37);border-right:none;
  border-radius:8px 0 0 8px;padding:8px 10px;font:12px/1 system-ui,sans-serif;
  box-shadow:-4px 0 12px rgba(0,0,0,.3);writing-mode:vertical-rl;letter-spacing:2px;}
.dsh-poly-fab:hover{background:var(--color-bg-3,#232732);}
.dsh-poly-search{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--color-border-1,#2a2e37);}
.dsh-poly-search input{flex:1;min-width:0;background:var(--color-bg-2,#1b1e26);color:inherit;
  border:1px solid var(--color-border-1,#2a2e37);border-radius:6px;padding:6px 8px;font:inherit;outline:none;}
.dsh-poly-search input:focus{border-color:var(--dsh-poly-accent,#3b82f6);}
.dsh-poly-search button{background:var(--dsh-poly-accent,#3b82f6);color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;}
.dsh-poly-list{overflow-y:auto;flex:1;padding:8px;}
.dsh-poly-event{margin-bottom:10px;}
.dsh-poly-event-title{font-weight:600;opacity:.85;margin-bottom:4px;}
.dsh-poly-item{display:block;width:100%;text-align:left;padding:8px;border-radius:8px;margin-bottom:6px;
  background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);
  color:inherit;font:inherit;cursor:pointer;}
.dsh-poly-item:hover{border-color:var(--dsh-poly-accent,#3b82f6);}
.dsh-poly-q{margin-bottom:4px;}
.dsh-poly-sides{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;}
.dsh-poly-sides .dsh-poly-star{margin-left:auto;}
.dsh-poly-side1{opacity:.75;font-variant-numeric:tabular-nums;font-size:12px;}
.dsh-poly-sides-detail{font-size:14px;}
.dsh-poly-bar{height:6px;border-radius:3px;background:var(--color-bg-1,#14161c);
  border:1px solid var(--color-border-1,#2a2e37);overflow:hidden;}
.dsh-poly-bar-fill{height:100%;border-radius:2px;
  background:linear-gradient(90deg,var(--dsh-poly-accent,#3b82f6),var(--dsh-poly-up,#34d399));
  transition:width .4s ease;}
.dsh-poly-bar-detail{height:10px;margin-bottom:8px;}
.dsh-poly-event-title{font-weight:600;opacity:.85;margin-bottom:4px;display:flex;align-items:center;gap:6px;}
.dsh-poly-eicon{width:18px;height:18px;border-radius:4px;object-fit:cover;flex-shrink:0;}
.dsh-poly-etitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.dsh-poly-yes{color:var(--dsh-poly-up,#34d399);font-weight:600;font-variant-numeric:tabular-nums;}
.dsh-poly-vol{opacity:.6;font-size:11px;font-variant-numeric:tabular-nums;}
.dsh-poly-detail{display:flex;flex-direction:column;flex:1;overflow-y:auto;padding:8px 10px;}
.dsh-poly-detail-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
.dsh-poly-back{background:none;border:none;color:var(--dsh-poly-accent,#3b82f6);cursor:pointer;font:inherit;padding:2px 4px;}
.dsh-poly-mid{margin-bottom:8px;}
.dsh-poly-spark-wrap{background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);border-radius:8px;padding:8px;}
.dsh-poly-spark{display:block;width:100%;height:auto;color:var(--color-text-1,#e6e6e6);}
.dsh-poly-err{padding:12px;color:var(--dsh-poly-down,#f87171);}
.dsh-poly-loading{padding:12px;opacity:.6;}
.dsh-poly-note{opacity:.6;font-size:11px;padding:4px 0;}
.dsh-poly-item-foot-r{display:flex;align-items:center;gap:6px;flex-shrink:0;}
.dsh-poly-star{background:none;border:none;color:var(--dsh-poly-star,#f5c518);cursor:pointer;
  font-size:15px;line-height:1;padding:2px;opacity:.45;}
.dsh-poly-star:hover{opacity:1;}
.dsh-poly-star.on{opacity:1;}
.dsh-poly-watch{margin-bottom:10px;padding:8px;border-radius:8px;
  background:var(--color-bg-3,#232732);border:1px dashed var(--color-border-1,#2a2e37);}
.dsh-poly-watch-title{font-size:11px;font-weight:600;opacity:.75;margin-bottom:6px;}
.dsh-poly-win{display:flex;gap:4px;margin:0 0 6px;}
.dsh-poly-win button{flex:1;background:var(--color-bg-2,#1b1e26);color:inherit;
  border:1px solid var(--color-border-1,#2a2e37);border-radius:6px;
  font:11px/1.6 system-ui,sans-serif;cursor:pointer;padding:2px 0;opacity:.7;}
.dsh-poly-win button:hover{opacity:1;}
.dsh-poly-win button.on{border-color:var(--dsh-poly-accent,#3b82f6);color:var(--dsh-poly-accent,#3b82f6);opacity:1;font-weight:600;}
.dsh-poly-link{display:inline-block;margin-top:8px;color:var(--dsh-poly-accent,#3b82f6);
  text-decoration:none;font-size:12px;}
.dsh-poly-link:hover{text-decoration:underline;}
.dsh-poly-detail-head-r{display:flex;align-items:center;gap:6px;}
.dsh-poly-drag{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:2;}
.dsh-poly-drag:hover,.dsh-poly-drag:active{background:linear-gradient(90deg,transparent,var(--dsh-poly-accent,#3b82f6),transparent);opacity:.6;}
.dsh-poly-follow{background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:2px;opacity:.35;}
.dsh-poly-follow:hover{opacity:.8;}
.dsh-poly-follow.on{opacity:1;}
.dsh-poly-follow.on::after{content:'跟随';font-size:9px;color:var(--dsh-poly-accent,#3b82f6);margin-left:3px;}
`
      const el = document.createElement('style')
      el.id = 'dsh-polymarket-style'
      el.textContent = css
      document.head.appendChild(el)
    }

    const inject = ['slots', 'sessions']
    function apply(ctx) {
      injectStyle()
      try {
        wireFollow(ctx)
      } catch (e) {
        console.warn('[dsh-polymarket] 跟随会话初始化失败（面板其余功能不受影响）:', e)
      }
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-polymarket', order: 100, label: 'Polymarket 行情' },
          MarketPanel,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
