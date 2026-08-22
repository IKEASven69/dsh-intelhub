/**
 * @dsh-external/dsh-polymarket — 静态客户端面板（shell.overlay 浮动侧栏）。
 *
 * 与老的动态 cordis client-half.js 不同：本文件是【静态】客户端模块，
 * 通过 window.__ModuleLoader__.load({ id, factory }) 注册，直接由 Web 应用
 * 加载（无需 agent 运行、无需 pluginRunId）。
 *
 * 数据通道：浏览器直连 Polymarket Gamma API（已验证 CORS: *），不经宿主
 * host.call（静态插件没有 pluginRunId，无法走 dynamicCordisRunner.invoke）。
 *
 * 落点：shell.overlay（list/root，叠加浮动层，点击穿透直到本面板启用
 * pointer-events）。定位于视口右侧、全高、宽 360px，实现「并排查看」。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-polymarket',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useState, useEffect, createElement: h } = React

    const GAMMA = 'https://gamma-api.polymarket.com'
    const DEFAULT_Q = 'president'
    const DEFAULT_LIMIT = 5

    // 把 outcomePrices（字符串 JSON，如 "[\"0.3\",\"0.7\"]"）解析为 Yes 价。
    function yesPrice(m) {
      try {
        const p = JSON.parse(m.outcomesPrices || '[]')
        return p[0] ?? '?'
      } catch {
        return '?'
      }
    }

    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-polymarket-style')) return
      const css = `
.dsh-poly-panel{
  position:fixed;top:0;right:0;height:100vh;width:360px;z-index:50;
  pointer-events:auto;display:flex;flex-direction:column;
  background:var(--color-bg-1,#14161c);color:var(--color-text-1,#e6e6e6);
  border-left:1px solid var(--color-border-1,#2a2e37);
  font:13px/1.5 system-ui,-apple-system,sans-serif;
  box-shadow:-8px 0 24px rgba(0,0,0,.35);
}
.dsh-poly-header{padding:10px 12px;font-weight:600;border-bottom:1px solid var(--color-border-1,#2a2e37);display:flex;align-items:center;justify-content:space-between;}
.dsh-poly-header .q{color:#3b82f6;}
.dsh-poly-list{overflow-y:auto;flex:1;padding:8px;}
.dsh-poly-event{margin-bottom:10px;}
.dsh-poly-event-title{font-weight:600;opacity:.85;margin-bottom:4px;}
.dsh-poly-item{padding:8px;border-radius:8px;margin-bottom:6px;background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);}
.dsh-poly-q{margin-bottom:4px;}
.dsh-poly-yes{color:#34d399;font-weight:600;}
.dsh-poly-vol{opacity:.6;font-size:11px;}
.dsh-poly-err{padding:12px;color:#f87171;}
.dsh-poly-loading{padding:12px;opacity:.6;}
`
      const el = document.createElement('style')
      el.id = 'dsh-polymarket-style'
      el.textContent = css
      document.head.appendChild(el)
    }

    function MarketPanel() {
      const [state, setState] = useState({ status: 'loading', events: [], error: null })
      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const url = `${GAMMA}/public-search?q=${encodeURIComponent(DEFAULT_Q)}&limit=${DEFAULT_LIMIT}`
            const res = await fetch(url, { headers: { 'user-agent': 'dsh-polymarket/0.1.0' } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            if (cancelled) return
            const events = (data.events || []).map((e) => ({
              title: e.title || '',
              markets: (e.markets || []).map((m) => ({
                question: m.question || '',
                yes: yesPrice(m),
                volume: m.volume ?? 0,
              })),
            }))
            setState({ status: 'ok', events, error: null })
          } catch (err) {
            if (cancelled) return
            setState({ status: 'error', events: [], error: String((err && err.message) || err) })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [])

      if (state.status === 'loading') {
        return h('div', { className: 'dsh-poly-panel' }, h('div', { className: 'dsh-poly-loading' }, '加载 Polymarket 行情…'))
      }
      if (state.status === 'error') {
        return h('div', { className: 'dsh-poly-panel' }, h('div', { className: 'dsh-poly-err' }, '行情加载失败：' + state.error))
      }
      return h(
        'div',
        { className: 'dsh-poly-panel' },
        h(
          'div',
          { className: 'dsh-poly-header' },
          h('span', null, 'Polymarket 行情'),
          h('span', { className: 'q' }, '#' + DEFAULT_Q),
        ),
        h(
          'div',
          { className: 'dsh-poly-list' },
          state.events.length === 0
            ? h('div', { className: 'dsh-poly-loading' }, '无结果')
            : state.events.map((ev, i) =>
                h(
                  'div',
                  { className: 'dsh-poly-event', key: i },
                  ev.title ? h('div', { className: 'dsh-poly-event-title' }, ev.title) : null,
                  ev.markets.map((m, j) =>
                    h(
                      'div',
                      { className: 'dsh-poly-item', key: j },
                      h('div', { className: 'dsh-poly-q' }, m.question),
                      h(
                        'div',
                        null,
                        h('span', { className: 'dsh-poly-yes' }, 'Yes ≈ ' + m.yes),
                        '  ',
                        h('span', { className: 'dsh-poly-vol' }, '量 ' + m.volume),
                      ),
                    ),
                  ),
                ),
              ),
        ),
      )
    }

    const inject = ['slots']
    function apply(ctx) {
      injectStyle()
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
