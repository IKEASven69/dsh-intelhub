/**
 * dsh-deck — 静态客户端（D2：知识调研台·读侧）。
 *
 * __ModuleLoader__.load 注册；数据全走 host 路由（同源 fetch，写方法浏览器
 * 自动带 Origin 头，security.allowRequest 放行）。落点：sidebar.footer.action
 * 「🧠 知识」入口 + shell.overlay 面板（order 90，与 polymarket=100 错位）。
 * 四标签：搜索（FTS）/ 四库（kb 导航）/ 点子（捕获+采纳）/ 复盘（LESSONS）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deck',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useState, useEffect, createElement: h } = React

    const LS_OPEN = 'dsh-deck-open'
    const API = {
      search: (q) => post('/api/deck/search', { q }),
      list: (root, path) => post('/api/deck/fs/list', { root, path }),
      read: (root, path) => post('/api/deck/fs/read', { root, path }),
      ideas: () => get('/api/deck/ideas'),
      capture: (text) => post('/api/deck/idea/capture', { text }),
      adopt: (file, to) => post('/api/deck/idea/adopt', { file, to }),
      insights: () => get('/api/deck/insights'),
    }

    async function get(url) {
      const r = await fetch(url)
      return await r.json()
    }
    async function post(url, body) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return await r.json()
    }

    // ── 极简 md 渲染（标题/粗斜/行内码/代码块/列表/引用/链接/横线）──
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
    function inline(s) {
      return esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    }
    function mdToHtml(md) {
      const out = []
      let inCode = false, listType = null
      const closeList = () => { if (listType) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); listType = null } }
      for (const line of md.split(/\r?\n/)) {
        if (line.trim().startsWith('```')) {
          if (inCode) { out.push('</code></pre>'); inCode = false } else { closeList(); out.push('<pre><code>'); inCode = true }
          continue
        }
        if (inCode) { out.push(esc(line)); continue }
        const t = line.trim()
        if (t === '') { closeList(); continue }
        const h = t.match(/^(#{1,4})\s+(.*)$/)
        if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue }
        if (/^(---|\*\*\*)$/.test(t)) { closeList(); out.push('<hr>'); continue }
        const bq = t.match(/^>\s?(.*)$/)
        if (bq) { closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue }
        const ol = t.match(/^(\d+)[.)]\s+(.*)$/)
        const ul = t.match(/^[-*+]\s+(.*)$/)
        if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' } out.push(`<li>${inline(ol[2])}</li>`); continue }
        if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' } out.push(`<li>${inline(ul[1])}</li>`); continue }
        if (t.startsWith('|')) { closeList(); out.push(`<div class="md-tr">${inline(t)}</div>`); continue }
        closeList()
        out.push(`<p>${inline(t)}</p>`)
      }
      closeList()
      if (inCode) out.push('</code></pre>')
      return out.join('\n')
    }

    function Preview({ root, path, onBack, title }) {
      const [text, setText] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        setText(null); setErr(null)
        API.read(root, path).then((j) => {
          if (!alive) return
          if (j.ok) { setText(j.content) } else { setErr(j.error) }
        }).catch((e) => alive && setErr(String(e)))
        return () => { alive = false }
      }, [root, path])
      return h('div', { className: 'deck-preview' },
        h('div', { className: 'deck-preview-head' },
          h('button', { className: 'deck-back', onClick: onBack }, '‹ 返回'),
          h('span', { className: 'deck-preview-path' }, title || path)),
        err !== null ? h('div', { className: 'deck-note deck-err' }, '读取失败：' + err) : null,
        text === null && err === null ? h('div', { className: 'deck-note' }, '加载中…') : null,
        text !== null ? h('div', { className: 'deck-md', dangerouslySetInnerHTML: { __html: mdToHtml(text) } }) : null,
      )
    }

    function SearchTab() {
      const [q, setQ] = useState('')
      const [res, setRes] = useState(null)
      const [busy, setBusy] = useState(false)
      const [file, setFile] = useState(null)
      const submit = (e) => {
        e.preventDefault()
        if (q.trim() === '') return
        setBusy(true); setRes(null); setFile(null)
        API.search(q).then((j) => { setRes(j); setBusy(false) }).catch(() => setBusy(false))
      }
      if (file !== null) return h(Preview, { root: 'kb', path: file.path, title: file.title, onBack: () => setFile(null) })
      return h('div', { className: 'deck-tab' },
        h('form', { className: 'deck-searchrow', onSubmit: submit },
          h('input', { value: q, onChange: (e) => setQ(e.target.value), placeholder: '全文搜索 5578 篇…（中文子串可查）', 'aria-label': '知识库搜索' }),
          h('button', { type: 'submit' }, '搜索')),
        busy ? h('div', { className: 'deck-note' }, '搜索中…') : null,
        res !== null && res.ok && (res.results ?? []).length === 0 ? h('div', { className: 'deck-note' }, `无结果（索引 ${res.indexed ?? '?'} 篇，${res.tookMs ?? '?'}ms）`) : null,
        res !== null && res.ok === false ? h('div', { className: 'deck-note deck-err' }, res.error) : null,
        (res?.results ?? []).map((r, i) =>
          h('div', { key: i, className: 'deck-hit', role: 'button', tabIndex: 0, onClick: () => setFile(r) },
            h('div', { className: 'deck-hit-title' }, r.title),
            h('div', { className: 'deck-hit-path' }, r.path),
            h('div', { className: 'deck-hit-snip' }, h('span', { dangerouslySetInnerHTML: { __html: esc(r.snippet).replaceAll('«', '<mark>').replaceAll('»', '</mark>') } })))),
        res !== null && res.ok && (res.results ?? []).length > 0
          ? h('div', { className: 'deck-note deck-fine' }, `${res.results.length} 条 · ${res.tookMs}ms · 索引 ${res.indexed} 篇`) : null,
      )
    }

    const LAYERS = [['', '根目录'], ['collections', '① 采集'], ['research', '② 事实'], ['insights', '③ 判断'], ['skills', '④ 方法论'], ['ideas', '⑤ 点子']]

    function BrowseTab() {
      const [dir, setDir] = useState('')
      const [entries, setEntries] = useState(null)
      const [file, setFile] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        setEntries(null); setErr(null)
        API.list('kb', dir).then((j) => {
          if (!alive) return
          if (j.ok) { setEntries(j.entries) } else { setErr(j.error) }
        }).catch((e) => alive && setErr(String(e)))
        return () => { alive = false }
      }, [dir])
      if (file !== null) return h(Preview, { root: 'kb', path: file, title: file.split('/').pop(), onBack: () => setFile(null) })
      return h('div', { className: 'deck-tab' },
        h('div', { className: 'deck-crumbs' },
          dir === ''
            ? LAYERS.map(([slug, label]) =>
                h('button', { key: slug, className: 'deck-chip', onClick: () => setDir(slug) }, label))
            : h('span', null,
                h('button', { className: 'deck-back', onClick: () => setDir(dir.split('/').slice(0, -1).join('/')) }, '‹ '),
                h('span', { className: 'deck-crumb-path' }, dir))),
        err !== null ? h('div', { className: 'deck-note deck-err' }, err) : null,
        entries === null && err === null ? h('div', { className: 'deck-note' }, '读取中…') : null,
        (entries ?? []).map((e) =>
          h('div', {
            key: e.name, className: 'deck-entry' + (e.type === 'dir' ? ' dir' : ''),
            role: 'button', tabIndex: 0,
            onClick: () => {
              const next = dir === '' ? e.name : dir + '/' + e.name
              if (e.type === "dir") { setDir(next) } else { setFile(next) }
            },
          }, (e.type === 'dir' ? '📁 ' : '📄 ') + e.name)),
      )
    }

    function IdeasTab() {
      const [ideas, setIdeas] = useState(null)
      const [text, setText] = useState('')
      const [msg, setMsg] = useState(null)
      const reload = () => API.ideas().then((j) => setIdeas(j.ok ? j.ideas : [])).catch(() => setIdeas([]))
      useEffect(() => { reload() }, [])
      const capture = (e) => {
        e.preventDefault()
        if (text.trim() === '') return
        API.capture(text).then((j) => {
          setMsg(j.ok ? '已捕获 ✓' : ('失败：' + j.error))
          setText(''); reload()
        })
      }
      const adopt = (file, to) => API.adopt(file, to).then((j) => {
        setMsg(j.ok ? (to === 'research' ? '已成调研任务卡（kb/TASK.md）✓' : '已成选题夹（content/）✓') : '失败：' + j.error)
        reload()
      })
      return h('div', { className: 'deck-tab' },
        h('form', { className: 'deck-searchrow', onSubmit: capture },
          h('input', { value: text, onChange: (e) => setText(e.target.value), placeholder: '随手记一个点子…（首行会成为标题）', 'aria-label': '捕获点子' }),
          h('button', { type: 'submit' }, '记下')),
        msg !== null ? h('div', { className: 'deck-note' }, msg) : null,
        ideas === null ? h('div', { className: 'deck-note' }, '加载中…') : null,
        ideas !== null && ideas.length === 0 ? h('div', { className: 'deck-note' }, '还没有点子（存在 knowledge-base/ideas/）') : null,
        (ideas ?? []).map((idea) =>
          h('div', { key: idea.file, className: 'deck-idea' + (idea.status === 'picked' ? ' picked' : '') },
            h('div', { className: 'deck-idea-head' },
              h('span', { className: 'deck-idea-title' }, idea.title),
              h('span', { className: 'deck-idea-status s-' + idea.status },
                idea.status === 'seed' ? '🌱 埋子' : idea.status === 'incubating' ? '🥚 孵化' : '✅ 已采纳')),
            idea.status !== 'picked'
              ? h('div', { className: 'deck-idea-actions' },
                  h('button', { className: 'deck-mini', onClick: () => adopt(idea.file, 'research') }, '→ 调研卡'),
                  h('button', { className: 'deck-mini', onClick: () => adopt(idea.file, 'content') }, '→ 选题夹'))
              : null)),
      )
    }

    function ReviewTab() {
      const [html, setHtml] = useState(null)
      const [stat, setStat] = useState(null)
      useEffect(() => {
        let alive = true
        API.insights().then((j) => {
          if (!alive || !j.ok) { if (alive) setHtml('<p>读取失败</p>'); return }
          setHtml(mdToHtml(j.content))
          const warn = (j.content.match(/⚠️|待验证/g) ?? []).length
          const okc = (j.content.match(/✅/g) ?? []).length
          setStat(`${okc} 已验证 · ${warn} 待验证标记`)
        })
        return () => { alive = false }
      }, [])
      return h('div', { className: 'deck-tab' },
        stat !== null ? h('div', { className: 'deck-note' }, '复盘纪律：每调研必提炼 1-3 条判断 · ' + stat) : null,
        h('div', { className: 'deck-md', dangerouslySetInnerHTML: { __html: html ?? '<p>加载中…</p>' } }),
      )
    }

    function DeckPanel() {
      const [tab, setTab] = useState('search')
      const tabs = [['search', '🔍 搜索'], ['browse', '📚 四库'], ['ideas', '💡 点子'], ['review', '🔁 复盘']]
      return h('div', { className: 'deck-panel' },
        h('div', { className: 'deck-header' },
          h('span', { className: 'deck-title' }, '🧠 知识调研台'),
          h('span', { className: 'deck-header-r' },
            h('a', { href: 'https://github.com', onClick: (e) => e.preventDefault(), style: { display: 'none' } }, ''),
            h('button', { className: 'deck-close', title: '收起', onClick: () => { window.dispatchEvent(new CustomEvent('dsh-deck-toggle')) } }, '›'))),
        h('div', { className: 'deck-tabs' }, tabs.map(([id, label]) =>
          h('button', { key: id, className: tab === id ? 'on' : '', onClick: () => setTab(id) }, label))),
        h('div', { className: 'deck-body' },
          tab === 'search' ? h(SearchTab) : tab === 'browse' ? h(BrowseTab) : tab === 'ideas' ? h(IdeasTab) : h(ReviewTab)),
      )
    }

    // 开合：模块级事件 + localStorage，入口按钮与面板共享
    let open = null
    function isOpen() { return open ??= false }
    function setOpen(v) { open = v; try { localStorage.setItem(LS_OPEN, v ? '1' : '0') } catch {} notify() }
    const listeners = new Set()
    function notify() { for (const fn of listeners) { try { fn() } catch {} } }

    function Root() {
      const [, force] = useState(0)
      useEffect(() => {
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        window.addEventListener('dsh-deck-toggle', () => setOpen(!isOpen()))
        return () => { listeners.delete(fn) }
      }, [])
      try { open ??= localStorage.getItem(LS_OPEN) === '1' } catch { open = false }
      return isOpen() ? h(DeckPanel) : null
    }

    function injectStyle() {
      if (document.getElementById('dsh-deck-style')) return
      const css = `
.deck-panel{position:fixed;top:0;right:0;height:100vh;width:440px;z-index:49;display:flex;flex-direction:column;
  background:var(--color-bg-1,#14161c);color:var(--color-text-1,#e6e6e6);
  border-left:1px solid var(--color-border-1,#2a2e37);font:13px/1.6 system-ui,sans-serif;
  box-shadow:-8px 0 24px rgba(0,0,0,.35);}
.deck-header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;font-weight:600;border-bottom:1px solid var(--color-border-1,#2a2e37);}
.deck-header-r{display:flex;gap:4px;}
.deck-close{background:none;border:none;color:inherit;font-size:18px;cursor:pointer;opacity:.7;}
.deck-close:hover{opacity:1;}
.deck-tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--color-border-1,#2a2e37);}
.deck-tabs button{background:none;border:1px solid transparent;border-radius:999px;color:inherit;font:12px/1.6 system-ui;cursor:pointer;padding:2px 10px;opacity:.65;}
.deck-tabs button.on{border-color:var(--dsh-deck-accent,#5b6cff);color:var(--dsh-deck-accent,#5b6cff);opacity:1;font-weight:600;}
.deck-body{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;min-height:0;}
.deck-tab{display:flex;flex-direction:column;gap:8px;min-height:0;}
.deck-searchrow{display:flex;gap:6px;}
.deck-searchrow input{flex:1;min-width:0;background:var(--color-bg-2,#1b1e26);color:inherit;border:1px solid var(--color-border-1,#2a2e37);border-radius:6px;padding:6px 8px;font:inherit;outline:none;}
.deck-searchrow input:focus{border-color:var(--dsh-deck-accent,#5b6cff);}
.deck-searchrow button{background:var(--dsh-deck-accent,#5b6cff);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;}
.deck-note{opacity:.65;font-size:12px;padding:2px 2px;}
.deck-fine{font-size:11px;}
.deck-err{color:#f87171;opacity:1;}
.deck-hit{padding:8px;border-radius:8px;background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);cursor:pointer;}
.deck-hit:hover{border-color:var(--dsh-deck-accent,#5b6cff);}
.deck-hit-title{font-weight:600;margin-bottom:2px;}
.deck-hit-path{font-size:11px;opacity:.55;font-family:ui-monospace,monospace;}
.deck-hit-snip{font-size:12px;opacity:.8;margin-top:4px;}
.deck-hit-snip mark{background:rgba(91,108,255,.35);color:inherit;border-radius:2px;padding:0 1px;}
.deck-crumbs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;}
.deck-chip{background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);border-radius:999px;color:inherit;font:12px/1.6 system-ui;cursor:pointer;padding:2px 10px;}
.deck-chip:hover{border-color:var(--dsh-deck-accent,#5b6cff);}
.deck-crumb-path{font-family:ui-monospace,monospace;font-size:12px;opacity:.75;}
.deck-back{background:none;border:none;color:var(--dsh-deck-accent,#5b6cff);cursor:pointer;font:inherit;padding:2px 4px;}
.deck-entry{padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.deck-entry:hover{background:var(--color-bg-2,#1b1e26);}
.deck-entry.dir{opacity:.9;}
.deck-idea{padding:8px;border-radius:8px;background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);}
.deck-idea.picked{opacity:.6;}
.deck-idea-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}
.deck-idea-title{font-weight:600;}
.deck-idea-status{font-size:11px;flex-shrink:0;}
.deck-idea-actions{display:flex;gap:6px;margin-top:6px;}
.deck-mini{background:var(--color-bg-3,#232732);color:var(--dsh-deck-accent,#5b6cff);border:1px solid var(--color-border-1,#2a2e37);border-radius:6px;font:11px/1.6 system-ui;cursor:pointer;padding:2px 8px;}
.deck-mini:hover{border-color:var(--dsh-deck-accent,#5b6cff);}
.deck-preview{display:flex;flex-direction:column;flex:1;min-height:0;}
.deck-preview-head{display:flex;align-items:center;gap:6px;margin-bottom:4px;}
.deck-preview-path{font-family:ui-monospace,monospace;font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.deck-md{overflow-y:auto;flex:1;min-height:0;padding:4px 2px;}
.deck-md h1,.deck-md h2,.deck-md h3,.deck-md h4{margin:.7em 0 .3em;}
.deck-md h1{font-size:1.3em;}.deck-md h2{font-size:1.15em;}
.deck-md p{margin:.35em 0;}
.deck-md pre{background:var(--color-bg-2,#1b1e26);border-radius:8px;padding:8px;overflow-x:auto;font-size:12px;}
.deck-md code{font-family:ui-monospace,monospace;font-size:.92em;background:var(--color-bg-2,#1b1e26);border-radius:3px;padding:0 3px;}
.deck-md pre code{background:none;padding:0;}
.deck-md blockquote{border-left:3px solid var(--color-border-1,#2a2e37);margin:.4em 0;padding:.1em 0 .1em 10px;opacity:.85;}
.deck-md a{color:var(--dsh-deck-accent,#5b6cff);}
.deck-md ul,.deck-md ol{margin:.35em 0;padding-left:1.4em;}
.deck-md hr{border:none;border-top:1px solid var(--color-border-1,#2a2e37);margin:.8em 0;}
.deck-md table,.deck-md .md-tr{font-size:12px;}
.deck-fab{position:fixed;bottom:96px;right:0;z-index:49;pointer-events:auto;cursor:pointer;
  background:var(--color-bg-2,#1b1e26);color:var(--color-text-1,#e6e6e6);
  border:1px solid var(--color-border-1,#2a2e37);border-right:none;
  border-radius:8px 0 0 8px;padding:8px 10px;font:12px/1 system-ui;letter-spacing:1px;
  box-shadow:-4px 0 12px rgba(0,0,0,.3);}
.deck-fab:hover{background:var(--color-bg-3,#232732);}
.deck-sidebtn{background:none;border:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;padding:6px;border-radius:6px;}
.deck-sidebtn:hover{background:var(--color-bg-3,#232732);}
`
      const el = document.createElement('style')
      el.id = 'dsh-deck-style'
      el.textContent = css
      document.head.appendChild(el)
    }

    const inject = ['slots']
    function apply(ctx) {
      injectStyle()
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-deck', order: 90, label: '知识调研台' }, Root))
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-deck', order: 20 },
          () => h('button', {
            className: 'deck-sidebtn', title: '知识调研台（dsh-deck）',
            onClick: () => setOpen(!isOpen()),
          }, '🧠')))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
