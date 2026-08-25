/**
 * dsh-deck — 静态客户端 v2：全屏工作台形态。
 * 布局：左栏（应用/项目）+ 顶栏 + 主工作区；知识台为第一个应用（D2 功能
 * 全量保留：搜索/四库/点子/复盘），自媒体台占位（D4），控制室占位（D3下）。
 * 数据全走 host 路由（同源 fetch）。
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
      state: () => get('/api/deck/state'),
      ideas: () => get('/api/deck/ideas'),
      capture: (text) => post('/api/deck/idea/capture', { text }),
      adopt: (file, to) => post('/api/deck/idea/adopt', { file, to }),
      insights: () => get('/api/deck/insights'),
    }
    async function get(url) { const r = await fetch(url); return await r.json() }
    async function post(url, body) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return await r.json()
    }

    // ── md 渲染 ──
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
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
      const closeList = () => { if (listType !== null) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); listType = null } }
      for (const line of String(md).split(/\r?\n/)) {
        if (line.trim().startsWith('```')) {
          if (inCode) { out.push('</code></pre>'); inCode = false } else { closeList(); out.push('<pre><code>'); inCode = true }
          continue
        }
        if (inCode) { out.push(esc(line)); continue }
        const t = line.trim()
        if (t === '') { closeList(); continue }
        const hd = t.match(/^(#{1,4})\s+(.*)$/)
        if (hd !== null) { closeList(); out.push('<h' + hd[1].length + '>' + inline(hd[2]) + '</h' + hd[1].length + '>'); continue }
        if (/^(---|\*\*\*)$/.test(t)) { closeList(); out.push('<hr>'); continue }
        const bq = t.match(/^>\s?(.*)$/)
        if (bq !== null) { closeList(); out.push('<blockquote>' + inline(bq[1]) + '</blockquote>'); continue }
        const ol = t.match(/^(\d+)[.)]\s+(.*)$/)
        const ul = t.match(/^[-*+]\s+(.*)$/)
        if (ol !== null) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' } out.push('<li>' + inline(ol[2]) + '</li>'); continue }
        if (ul !== null) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' } out.push('<li>' + inline(ul[1]) + '</li>'); continue }
        closeList()
        out.push('<p>' + inline(t) + '</p>')
      }
      closeList()
      if (inCode) out.push('</code></pre>')
      return out.join('\n')
    }

    // ── 通用小组件 ──
    function Note({ children }) { return h('div', { className: 'dk-note' }, children) }
    function Err({ children }) { return h('div', { className: 'dk-note dk-err' }, children) }

    function Preview({ root, path, onBack, title }) {
      const [text, setText] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        setText(null); setErr(null)
        API.read(root, path).then((j) => {
          if (!alive) return
          if (j.ok) { setText(j.content) } else { setErr(j.error) }
        }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [root, path])
      return h('div', { className: 'dk-preview' },
        h('div', { className: 'dk-preview-head' },
          h('button', { className: 'dk-back', onClick: onBack }, '‹ 返回'),
          h('span', { className: 'dk-path' }, title || path)),
        err !== null ? h(Err, null, '读取失败：' + err) : null,
        text === null && err === null ? h(Note, null, '加载中…') : null,
        text !== null ? h('div', { className: 'dk-md', dangerouslySetInnerHTML: { __html: mdToHtml(text) } }) : null,
      )
    }

    // ── 知识台·搜索 ──
    function KbSearch() {
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
      return h('div', { className: 'dk-col' },
        h('form', { className: 'dk-searchbar', onSubmit: submit },
          h('input', { value: q, onChange: (e) => setQ(e.target.value), placeholder: '全文搜索 5486 篇（中文子串可查）…', 'aria-label': '知识库搜索' }),
          h('button', { type: 'submit' }, '搜索')),
        busy ? h(Note, null, '搜索中…') : null,
        res !== null && res.ok === false ? h(Err, null, res.error) : null,
        res !== null && res.ok && (res.results ?? []).length === 0 ? h(Note, null, '无结果（索引 ' + (res.indexed ?? '?') + ' 篇）') : null,
        res !== null && res.ok && (res.results ?? []).length > 0
          ? h('div', { className: 'dk-toolbar' },
              h('span', { className: 'dk-fine' }, res.results.length + ' 条 · ' + res.tookMs + 'ms · 索引 ' + res.indexed + ' 篇'))
          : null,
        h('div', { className: 'dk-grid' },
          (res?.results ?? []).map((r, i) =>
            h('div', { key: i, className: 'dk-card', role: 'button', tabIndex: 0, onClick: () => setFile(r) },
              h('div', { className: 'dk-card-title' }, r.title),
              h('div', { className: 'dk-card-sub' }, r.path),
              h('div', { className: 'dk-card-snip', dangerouslySetInnerHTML: { __html: esc(r.snippet).replaceAll('«', '<mark>').replaceAll('»', '</mark>') } }))),
      ))
    }

    // ── 知识台·四库 ──
    const LAYERS = [['', '🏠 根目录'], ['collections', '① 采集'], ['research', '② 事实'], ['insights', '③ 判断'], ['skills', '④ 方法论'], ['ideas', '⑤ 点子']]

    function KbBrowse() {
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
        }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [dir])
      if (file !== null) return h(Preview, { root: 'kb', path: file, title: file.split('/').pop(), onBack: () => setFile(null) })
      return h('div', { className: 'dk-col' },
        h('div', { className: 'dk-toolbar' },
          dir === ''
            ? LAYERS.map(([slug, label]) => h('button', { key: slug, className: 'dk-chip', onClick: () => setDir(slug) }, label))
            : h('span', { className: 'dk-crumbrow' },
                h('button', { className: 'dk-back', onClick: () => setDir(dir.split('/').slice(0, -1).join('/')) }, '‹ 上级'),
                h('span', { className: 'dk-crumb' }, dir))),
        err !== null ? h(Err, null, err) : null,
        entries === null && err === null ? h(Note, null, '读取中…') : null,
        entries !== null && entries.length === 0 ? h(Note, null, '空目录') : null,
        h('div', { className: 'dk-grid' },
          (entries ?? []).map((e) =>
            h('div', {
              key: e.name, className: 'dk-card' + (e.type === 'dir' ? ' dir' : ''),
              role: 'button', tabIndex: 0,
              onClick: () => { const next = dir === '' ? e.name : dir + '/' + e.name; if (e.type === 'dir') { setDir(next) } else { setFile(next) } },
            },
              h('div', { className: 'dk-card-title' }, (e.type === 'dir' ? '📁 ' : '📄 ') + e.name))),
        ),
      )
    }

    // ── 知识台·点子 ──
    function KbIdeas() {
      const [ideas, setIdeas] = useState(null)
      const [text, setText] = useState('')
      const [msg, setMsg] = useState(null)
      const reload = () => API.ideas().then((j) => setIdeas(j.ok ? j.ideas : [])).catch(() => setIdeas([]))
      useEffect(() => { reload() }, [])
      const capture = (e) => {
        e.preventDefault()
        if (text.trim() === '') return
        API.capture(text).then((j) => { setMsg(j.ok ? '已捕获 ✓' : '失败：' + j.error); setText(''); reload() })
      }
      const adopt = (file, to) => API.adopt(file, to).then((j) => {
        setMsg(j.ok ? (to === 'research' ? '已成调研任务卡（kb/TASK.md）✓' : '已成选题夹（content/）✓') : '失败：' + j.error)
        reload()
      })
      return h('div', { className: 'dk-col' },
        h('form', { className: 'dk-searchbar', onSubmit: capture },
          h('input', { value: text, onChange: (e) => setText(e.target.value), placeholder: '随手记一个点子…（首行会成为标题）', 'aria-label': '捕获点子' }),
          h('button', { type: 'submit' }, '记下')),
        msg !== null ? h(Note, null, msg) : null,
        ideas === null ? h(Note, null, '加载中…') : null,
        ideas !== null && ideas.length === 0 ? h(Note, null, '还没有点子（存放在 knowledge-base/ideas/）') : null,
        h('div', { className: 'dk-grid' },
          (ideas ?? []).map((idea) =>
            h('div', { key: idea.file, className: 'dk-card' + (idea.status === 'picked' ? ' picked' : '') },
              h('div', { className: 'dk-card-title' }, idea.title),
              h('div', { className: 'dk-card-sub' },
                idea.status === 'seed' ? '🌱 埋子' : idea.status === 'incubating' ? '🥚 孵化' : '✅ 已采纳',
                idea.created !== '' ? ' · ' + idea.created : ''),
              idea.status !== 'picked'
                ? h('div', { className: 'dk-card-actions' },
                    h('button', { className: 'dk-mini', onClick: () => adopt(idea.file, 'research') }, '→ 调研卡'),
                    h('button', { className: 'dk-mini', onClick: () => adopt(idea.file, 'content') }, '→ 选题夹'))
                : null)),
        ),
      )
    }

    // ── 知识台·复盘 ──
    function KbReview() {
      const [html, setHtml] = useState(null)
      const [stat, setStat] = useState(null)
      useEffect(() => {
        let alive = true
        API.insights().then((j) => {
          if (!alive) return
          if (!j.ok) { setHtml('<p>读取失败</p>'); return }
          setHtml(mdToHtml(j.content))
          const warn = (j.content.match(/⚠️|待验证/g) ?? []).length
          const okc = (j.content.match(/✅/g) ?? []).length
          setStat(okc + ' 已验证 · ' + warn + ' 待验证标记')
        })
        return () => { alive = false }
      }, [])
      return h('div', { className: 'dk-col' },
        stat !== null ? h(Note, null, '复盘纪律：每调研必提炼 1-3 条判断 · ' + stat) : null,
        h('div', { className: 'dk-md page', dangerouslySetInnerHTML: { __html: html ?? '<p>加载中…</p>' } }),
      )
    }

    const KB_TABS = [['search', '🔍 搜索'], ['browse', '📚 四库'], ['ideas', '💡 点子'], ['review', '🔁 复盘']]

    function KnowledgeDesk() {
      const [tab, setTab] = useState('search')
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' }, KB_TABS.map(([id, label]) =>
          h('button', { key: id, className: tab === id ? 'on' : '', onClick: () => setTab(id) }, label))),
        h('div', { className: 'dk-deskmain' },
          tab === 'search' ? h(KbSearch) : tab === 'browse' ? h(KbBrowse) : tab === 'ideas' ? h(KbIdeas) : h(KbReview)),
      )
    }

    function MediaDesk() {
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' }, h('button', { className: 'on' }, '📋 选题看板')),
        h('div', { className: 'dk-deskmain' },
          h('div', { className: 'dk-empty' },
            h('div', { className: 'dk-empty-icon' }, '🎬'),
            h('div', { className: 'dk-empty-title' }, '自媒体台（D4）'),
            h('div', { className: 'dk-empty-sub' }, '文章 / 视频 / PPT 三形态 · 选题看板 · 预填发布 · 账号 · 评论')),
        ),
      )
    }

    function ControlRoom() {
      const [state, setState] = useState(null)
      useEffect(() => {
        let alive = true
        API.state().then((j) => { if (alive) setState(j) }).catch(() => {})
        return () => { alive = false }
      }, [])
      const projects = state?.projects ?? []
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' }, h('button', { className: 'on' }, '🖥️ 控制室')),
        h('div', { className: 'dk-deskmain' },
          h('div', { className: 'dk-grid wide' },
            projects.map((p) =>
              h('div', { key: p.id, className: 'dk-card room' + (p.hidden ? ' hidden' : '') },
                h('div', { className: 'dk-room-icon' }, p.icon || '📁'),
                h('div', { className: 'dk-card-title' }, p.name),
                h('div', { className: 'dk-card-sub' }, p.template === 'kb' ? '知识调研' : p.template === 'media' ? '自媒体' : '自定义'),
                h('div', { className: 'dk-room-status' }, p.id.startsWith('builtin-') ? '内置台面' : '项目'))),
            h('div', { className: 'dk-card room add' },
              h('div', { className: 'dk-room-icon' }, '＋'),
              h('div', { className: 'dk-card-title' }, '新建工作台'),
              h('div', { className: 'dk-card-sub' }, 'D3'))),
        ),
      )
    }

    // ── 工作台外壳 ──
    const APPS = [['kb', '🧠', '知识调研台'], ['media', '🎬', '自媒体台'], ['room', '🖥️', '控制室']]

    let openState = null
    const listeners = new Set()
    function notify() { for (const fn of listeners) { try { fn() } catch {} } }
    function isOpen() { return openState ?? false }
    function setOpen(v) { openState = v; try { localStorage.setItem(LS_OPEN, v ? '1' : '0') } catch {} notify() }

    function Workspace() {
      const [app, setApp] = useState('kb')
      const [, force] = useState(0)
      useEffect(() => {
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      }, [])
      if (openState === null) { try { openState = localStorage.getItem(LS_OPEN) === '1' } catch { openState = false } }
      if (!isOpen()) return null
      return h('div', { className: 'dk-shell' },
        h('div', { className: 'dk-rail' },
          h('div', { className: 'dk-rail-brand' }, 'DECK'),
          APPS.map(([id, icon, label]) =>
            h('button', { key: id, className: 'dk-rail-btn' + (app === id ? ' on' : ''), title: label, onClick: () => setApp(id) },
              h('span', { className: 'dk-rail-icon' }, icon),
              h('span', { className: 'dk-rail-label' }, label))),
          h('div', { className: 'dk-rail-fill' }),
          h('button', { className: 'dk-rail-btn close', title: '收起工作台', onClick: () => setOpen(false) },
            h('span', { className: 'dk-rail-icon' }, '»')),
        ),
        h('div', { className: 'dk-main' }, app === 'kb' ? h(KnowledgeDesk) : app === 'media' ? h(MediaDesk) : h(ControlRoom)),
      )
    }

    function injectStyle() {
      if (document.getElementById('dsh-deck-style')) return
      const css = `
.dk-shell{position:fixed;inset:0;z-index:60;display:flex;
  background:var(--color-bg-0,#0e1015);color:var(--color-text-1,#e6e6e6);
  font:13px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif;}
.dk-rail{width:56px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:2px;
  background:var(--color-bg-1,#14161c);border-right:1px solid var(--color-border-1,#2a2e37);padding:8px 0;}
.dk-rail-brand{font-weight:800;font-size:11px;letter-spacing:2px;color:var(--dk-accent,#5b6cff);padding:8px 0 12px;}
.dk-rail-btn{width:44px;padding:6px 0 4px;display:flex;flex-direction:column;align-items:center;gap:1px;
  background:none;border:none;border-radius:10px;color:inherit;cursor:pointer;opacity:.55;}
.dk-rail-btn:hover{opacity:.9;background:var(--color-bg-2,#1b1e26);}
.dk-rail-btn.on{opacity:1;background:var(--color-bg-2,#1b1e26);box-shadow:inset 0 0 0 1px var(--dk-accent,#5b6cff);}
.dk-rail-icon{font-size:17px;line-height:1.2;}
.dk-rail-label{font-size:9px;transform:scale(.92);}
.dk-rail-fill{flex:1;}
.dk-main{flex:1;display:flex;flex-direction:column;min-width:0;}
.dk-desk{flex:1;display:flex;flex-direction:column;min-height:0;padding:14px 16px 0;}
.dk-deskbar{display:flex;gap:6px;margin-bottom:12px;}
.dk-deskbar button{background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:999px;
  color:inherit;font:12.5px/1.6 system-ui;cursor:pointer;padding:4px 14px;opacity:.65;}
.dk-deskbar button:hover{opacity:1;}
.dk-deskbar button.on{border-color:var(--dk-accent,#5b6cff);color:var(--dk-accent,#5b6cff);opacity:1;font-weight:600;
  background:color-mix(in srgb,var(--dk-accent,#5b6cff) 10%,transparent);}
.dk-deskmain{flex:1;min-height:0;overflow-y:auto;padding-bottom:16px;}
.dk-col{display:flex;flex-direction:column;gap:10px;min-height:0;}
.dk-searchbar{display:flex;gap:8px;max-width:640px;}
.dk-searchbar input{flex:1;min-width:0;background:var(--color-bg-1,#14161c);color:inherit;
  border:1px solid var(--color-border-1,#2a2e37);border-radius:10px;padding:9px 12px;font:inherit;outline:none;}
.dk-searchbar input:focus{border-color:var(--dk-accent,#5b6cff);box-shadow:0 0 0 3px color-mix(in srgb,var(--dk-accent,#5b6cff) 18%,transparent);}
.dk-searchbar button{background:var(--dk-accent,#5b6cff);color:#fff;border:none;border-radius:10px;padding:9px 20px;cursor:pointer;font:inherit;font-weight:600;}
.dk-searchbar button:hover{filter:brightness(1.1);}
.dk-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dk-fine{font-size:11.5px;opacity:.55;}
.dk-chip{background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:999px;
  color:inherit;font:12px/1.6 system-ui;cursor:pointer;padding:3px 12px;}
.dk-chip:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-crumbrow{display:flex;align-items:center;gap:8px;}
.dk-crumb{font-family:ui-monospace,monospace;font-size:12px;opacity:.7;}
.dk-back{background:none;border:none;color:var(--dk-accent,#5b6cff);cursor:pointer;font:inherit;padding:2px 6px;}
.dk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;align-content:start;}
.dk-grid.wide{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));}
.dk-card{background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:12px;
  padding:12px 14px;cursor:pointer;transition:border-color .15s,transform .1s;position:relative;}
.dk-card:hover{border-color:var(--dk-accent,#5b6cff);transform:translateY(-1px);}
.dk-card.dir{opacity:.92;}
.dk-card.picked{opacity:.55;}
.dk-card-title{font-weight:600;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-card-sub{font-size:11px;opacity:.5;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-card-snip{font-size:12px;opacity:.8;margin-top:6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.dk-card-snip mark{background:color-mix(in srgb,var(--dk-accent,#5b6cff) 35%,transparent);color:inherit;border-radius:2px;padding:0 1px;}
.dk-card-actions{display:flex;gap:6px;margin-top:8px;}
.dk-mini{background:var(--color-bg-2,#1b1e26);color:var(--dk-accent,#5b6cff);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:8px;font:11.5px/1.6 system-ui;cursor:pointer;padding:2px 10px;}
.dk-mini:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-room-icon{font-size:24px;margin-bottom:4px;}
.dk-room-status{font-size:11px;opacity:.45;margin-top:6px;}
.dk-card.room{cursor:default;text-align:left;}
.dk-card.room.add{border-style:dashed;opacity:.6;}
.dk-note{opacity:.6;font-size:12.5px;padding:2px 2px;}
.dk-err{color:#f87171;opacity:1;}
.dk-preview{display:flex;flex-direction:column;gap:8px;max-width:860px;}
.dk-preview-head{display:flex;align-items:center;gap:8px;}
.dk-path{font-family:ui-monospace,monospace;font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-md{max-width:860px;}
.dk-md.page{padding:4px 2px;}
.dk-md h1,.dk-md h2,.dk-md h3,.dk-md h4{margin:.8em 0 .35em;}
.dk-md h1{font-size:1.35em;}.dk-md h2{font-size:1.18em;}.dk-md h3{font-size:1.06em;}
.dk-md p{margin:.4em 0;}
.dk-md pre{background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:10px;padding:10px;overflow-x:auto;font-size:12px;}
.dk-md code{font-family:ui-monospace,monospace;font-size:.92em;background:var(--color-bg-1,#14161c);border-radius:4px;padding:0 4px;}
.dk-md pre code{background:none;padding:0;}
.dk-md blockquote{border-left:3px solid var(--color-border-1,#2a2e37);margin:.4em 0;padding:.1em 0 .1em 12px;opacity:.85;}
.dk-md a{color:var(--dk-accent,#5b6cff);}
.dk-md ul,.dk-md ol{margin:.4em 0;padding-left:1.5em;}
.dk-md hr{border:none;border-top:1px solid var(--color-border-1,#2a2e37);margin:1em 0;}
.dk-md table{font-size:12px;}
.dk-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;opacity:.55;}
.dk-empty-icon{font-size:44px;}
.dk-empty-title{font-weight:600;font-size:15px;}
.dk-empty-sub{font-size:12px;}
.dk-sidebtn{background:none;border:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;padding:6px;border-radius:6px;}
.dk-sidebtn:hover{background:var(--color-bg-3,#232732);}
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
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-deck', order: 90, label: '工作台' }, Workspace))
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-deck', order: 20 },
          () => h('button', {
            className: 'dk-sidebtn', title: '工作台（dsh-deck）',
            onClick: () => setOpen(!isOpen()),
          }, '🗂️')))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
