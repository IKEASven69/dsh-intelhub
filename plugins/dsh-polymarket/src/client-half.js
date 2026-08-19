/**
 * dsh-polymarket — 浏览器半（cordis_define 的 code.client）。
 *
 * 形态：本文件内容就是 cordis 插件「函数体」字符串——宿主把它包进
 *   new Function(...symbols, `return (async () => {\n${code}\n})()`)
 * 因此：无 import / 无 JSX / 顶层必须 `return` 插件对象；`React`/`console`/`styles`/`host`/`harness`
 * 都是注入的符号面（symbol surface），`setTimeout`/`fetch`/`require` 等被宿主陷阱遮蔽。
 *
 * 职责：
 *  1. 登录状态检查：读 DSH 应用自身 `document.cookie`（未被遮蔽）——检测是否存在会话标识，
 *     未检测到时在卡片顶部给出 UI 提示；行情数据不受影响，仍走 host.call 拉取。
 *  2. 数据通路：`host.call(method, args)` → 宿主路由到本包 host 半的 handler（双向仅 JSON）。
 *  3. UI 落点：`tool.view.cordis` slot key='self'（动态代码专用 key，Guard 绑定当前 Plugin/Package），
 *     用 React.createElement 无 JSX 构建卡片。
 *  4. 主题：`styles.insert(css)` 注入，颜色走 DSH theme CSS 变量并带安全回退。
 */

/** 默认搜索词（host 半 handler 的默认值一致） */
const DEFAULT_QUERY = 'president'

/** 读取 DSH 应用自身 cookie，判断是否存在会话标识。
 *  note: 跨域读不到 polymarket.com 的 cookie——这里只表达「DSH 登录态」提示，不参与行情请求。 */
function sessionState() {
  if (typeof document === 'undefined') return { detected: false, raw: '' }
  const raw = typeof document.cookie === 'string' ? document.cookie : ''
  const detected = raw.length > 0
  // 常见会话标识名（宽松匹配：任一命中即认为已登录；没有则看是否有任何 cookie 证据）
  const names = ['session', 'token', 'dsh', 'sid', 'auth']
  const hit = names.find((n) => raw.toLowerCase().includes(n))
  return { detected, hint: hit ? `会话标识 ${hit}` : '存在 cookie 但未见会话标识名', raw: raw.slice(0, 80) }
}

/** 防御性解析单个 market 的 question 与 Yes 报价，渲染用，任何异常都不允许击穿组件 */
function summarizeMarket(m) {
  if (!m || typeof m !== 'object') return null
  const question = typeof m.question === 'string' ? m.question : ''
  let yes = ''
  try {
    const op = typeof m.outcomesPrices === 'string' ? JSON.parse(m.outcomesPrices) : m.outcomesPrices
    if (op && (typeof op.Yes === 'string' || typeof op.Yes === 'number')) {
      const pct = Math.round(Number(op.Yes) * 100)
      if (Number.isFinite(pct)) yes = `Yes ${pct}%`
    }
  } catch (_) { /* 不可解析的报价忽略，不阻塞渲染 */ }
  return { question, yes }
}

/** 把任意 reject 值规整成可显示的字符串 */
function describeError(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  try { return JSON.stringify(error) } catch (_) { return String(error) }
}

/** 行情卡片：挂载即 host.call 拉取搜索行情，渲染事件列表；顶部带登录态徽标 */
function MarketCard(props) {
  const [view, setView] = React.useState({ phase: 'loading' })

  React.useEffect(() => {
    let alive = true
    setView({ phase: 'loading' })
    host.call('polymarket_search_markets', { q: DEFAULT_QUERY, limit: 5 }).then(
      (value) => { if (alive) setView({ phase: 'ready', result: value || {} }) },
      (error) => { if (alive) setView({ phase: 'error', error: describeError(error) }) },
    )
    return () => { alive = false }
  }, [])

  const session = sessionState()
  const h = React.createElement

  // —— 登录态徽标 ——
  const badge = h('span', { className: session.detected ? 'dpm-badge dpm-badge-on' : 'dpm-badge dpm-badge-off' },
    session.detected ? 'DSH 会话已检测' : '未检测到 DSH 会话 cookie（document.cookie 为空）')

  // —— 主体内容分支 ——
  let body
  if (view.phase === 'loading') {
    body = h('div', { className: 'dpm-note' }, '加载中…')
  } else if (view.phase === 'error') {
    body = h('div', { className: 'dpm-note dpm-error' }, '行情拉取失败：' + view.error)
  } else {
    const result = view.result || {}
    const events = Array.isArray(result.events) ? result.events : []
    const rows = events.map((event, i) => {
      const title = event && (typeof event.title === 'string' ? event.title : event.slug) || ('事件 ' + (i + 1))
      const marketCount = event && Array.isArray(event.markets) ? event.markets.length : 0
      const first = event && Array.isArray(event.markets) && event.markets.length > 0
        ? summarizeMarket(event.markets[0]) : null
      const sub = first && (first.question || first.yes)
        ? h('div', { className: 'dpm-sub' },
            first.question ? first.question : '',
            first.yes ? h('span', { className: 'dpm-price' }, first.yes) : null)
        : null
      return h('div', { className: 'dpm-row', key: String(i) },
        h('div', { className: 'dpm-row-head' },
          h('span', { className: 'dpm-title' }, title),
          h('span', { className: 'dpm-count' }, marketCount + ' 市场')),
        sub)
    })
    body = rows.length > 0 ? rows : h('div', { className: 'dpm-note' }, '无事件返回')
  }

  return h('div', { className: 'dpm-card' },
    h('div', { className: 'dpm-head' },
      h('span', { className: 'dpm-name' }, 'Polymarket 行情'),
      badge),
    body,
    h('div', { className: 'dpm-foot' },
      props && props.packageId ? 'package ' + props.packageId + ' · ' : '',
      '数据经 host 半 proxy 拉取'))
}

return {
  name: 'dsh-polymarket',
  inject: ['slots'],
  apply(ctx) {
    // 主题样式：theme CSS 变量 + 安全回退（与 host 半 classifyContentType 的样式变量同族）
    styles.insert(`
.dpm-card { display:flex; flex-direction:column; gap:8px; padding:12px; border-radius:8px;
  background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f2328);
  font-size:13px; line-height:1.5; }
.dpm-head { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.dpm-name { font-weight:600; }
.dpm-badge { font-size:11px; padding:2px 8px; border-radius:999px; white-space:nowrap; }
.dpm-badge-on { background: var(--dsw-alias-success-bg, #e6f4ea); color: var(--dsw-alias-success-fg, #137333); }
.dpm-badge-off { background: var(--dsw-alias-warning-bg, #fef7e0); color: var(--dsw-alias-warning-fg, #b2600a); }
.dpm-row { display:flex; flex-direction:column; gap:2px; padding:6px 0; border-top:1px solid var(--dsw-alias-border-subtle, #eceff1); }
.dpm-row-head { display:flex; justify-content:space-between; gap:8px; }
.dpm-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dpm-count { flex-shrink:0; opacity:.7; font-variant-numeric:tabular-nums; }
.dpm-sub { display:flex; justify-content:space-between; gap:8px; opacity:.75; font-size:12px; }
.dpm-price { flex-shrink:0; font-variant-numeric:tabular-nums; }
.dpm-note { opacity:.7; }
.dpm-error { opacity:1; color: var(--dsw-alias-error-fg, #d93025); }
.dpm-foot { opacity:.55; font-size:11px; }
`)

    // 落点：tool.view.cordis key='self'（动态代码注册位，Guard 绑定当前 Plugin/Package，occupants:[]）
    ctx.slots.inject('tool.view.cordis', () => ctx.slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      MarketCard,
    ))
  },
}