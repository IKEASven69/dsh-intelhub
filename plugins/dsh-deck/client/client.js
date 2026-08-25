/**
 * dsh-deck — 静态客户端 v3：全屏工作台 + D3 任务协议。
 * v2：左栏（应用/项目）+ 台面标签 + 卡片网格（D2 读侧全量保留）。
 * v3：任务台（建卡→发给 zcode→状态轮询）、新建工作台向导、项目↔会话绑定、
 *      控制室统一看板（四列聚合）、收起 tile。数据全走 host 路由（同源 fetch）。
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
      roots: () => get('/api/deck/roots'),
      ideas: () => get('/api/deck/ideas'),
      capture: (text) => post('/api/deck/idea/capture', { text }),
      adopt: (file, to) => post('/api/deck/idea/adopt', { file, to }),
      insights: () => get('/api/deck/insights'),
      tasks: (project) => post('/api/deck/tasks', { project }),
      boards: () => post('/api/deck/tasks', {}),
      taskCreate: (project, title, type, acceptance, body) => post('/api/deck/task/create', { project, title, type, acceptance, body }),
      taskStatus: (project, id, status) => post('/api/deck/task/status', { project, id, status }),
      dispatch: (project) => post('/api/deck/task/dispatch', { project }),
      projectCreate: (input) => post('/api/deck/project/create', input),
      projectUpdate: (id, patch) => post('/api/deck/project/update', Object.assign({ id }, patch)),
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

    // ── 文件浏览（kb 四库 / 通用项目共用）──
    const LAYERS = [['', '🏠 根目录'], ['collections', '① 采集'], ['research', '② 事实'], ['insights', '③ 判断'], ['skills', '④ 方法论'], ['ideas', '⑤ 点子']]

    function FsBrowse({ root, base, layers }) {
      const [dir, setDir] = useState(base)
      const [entries, setEntries] = useState(null)
      const [file, setFile] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => { setDir(base) }, [root, base])
      useEffect(() => {
        let alive = true
        setEntries(null); setErr(null)
        API.list(root, dir).then((j) => {
          if (!alive) return
          if (j.ok) { setEntries(j.entries) } else { setErr(j.error) }
        }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [root, dir])
      if (file !== null) return h(Preview, { root, path: file, title: file.split('/').pop(), onBack: () => setFile(null) })
      return h('div', { className: 'dk-col' },
        h('div', { className: 'dk-toolbar' },
          dir === base && layers !== null
            ? layers.map(([slug, label]) => h('button', { key: slug, className: 'dk-chip', onClick: () => setDir(slug) }, label))
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

    // ── 任务台（D3）：建卡 → 发给 zcode → 状态轮询 ──
    const STATUS_META = {
      queued: ['⏳ 待接单', 'wait'], running: ['🏃 进行中', 'run'], review: ['👀 待审阅', 'rev'],
      done: ['✅ 完成', 'ok'], failed: ['❌ 失败', 'bad'],
    }
    const TYPE_LABEL = { research: '调研', article: '文章', video: '视频', ppt: 'PPT' }

    function TaskBoard({ projectId }) {
      const [cards, setCards] = useState(null)
      const [msg, setMsg] = useState(null)
      const [title, setTitle] = useState('')
      const [type, setType] = useState('research')
      const [acc, setAcc] = useState('')
      const reload = () => API.tasks(projectId).then((j) => {
        setCards(j.ok ? j.cards : [])
        if (!j.ok) setMsg('读取失败：' + j.error)
      }).catch((e) => setMsg(String(e)))
      useEffect(() => {
        reload()
        const t = setInterval(reload, 5000)
        return () => { clearInterval(t) }
      }, [projectId])
      const create = (e) => {
        e.preventDefault()
        if (title.trim() === '') return
        const acceptance = acc.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '').slice(0, 20)
        API.taskCreate(projectId, title, type, acceptance).then((j) => {
          setMsg(j.ok ? '任务卡已写入 TASK.md ✓（id ' + j.card.id + '）' : '失败：' + j.error)
          if (j.ok) { setTitle(''); setAcc(''); reload() }
        })
      }
      const dispatch = () => {
        setMsg('派发中…')
        API.dispatch(projectId).then((j) => {
          if (!j.ok) { setMsg('派发失败：' + j.error); return }
          setMsg(j.mode === 'terminal'
            ? '已开新终端跑 zcode（首次跑要装依赖/登录的话在终端里看）'
            : '终端拉起失败，命令已生成，请手动粘贴运行')
          window.__deckLastCmd = j.command
        }).catch((e) => setMsg(String(e)))
      }
      const copyCmd = async () => {
        const cmd = window.__deckLastCmd
        if (cmd === undefined) return
        try { await navigator.clipboard.writeText(cmd); setMsg('命令已复制 ✓') } catch { setMsg('复制失败，请手动选择') }
      }
      const markDone = (id) => API.taskStatus(projectId, id, 'done').then(() => reload())
      return h('div', { className: 'dk-col' },
        h('form', { className: 'dk-taskform', onSubmit: create },
          h('input', { value: title, onChange: (e) => setTitle(e.target.value), placeholder: '任务题目（如：调研 xxx 的现状与反方观点）', 'aria-label': '任务题目' }),
          h('select', { value: type, onChange: (e) => setType(e.target.value), 'aria-label': '任务类型' },
            Object.keys(TYPE_LABEL).map((t) => h('option', { key: t, value: t }, TYPE_LABEL[t]))),
          h('textarea', { value: acc, onChange: (e) => setAcc(e.target.value), rows: 2, placeholder: '验收条目（一行一条，可留空走默认：产出带来源的调研稿）', 'aria-label': '验收条目' }),
          h('button', { type: 'submit' }, '建卡'),
          h('button', { type: 'button', className: 'dk-ghost', onClick: dispatch }, '🚀 发给 zcode')),
        msg !== null
          ? h(Note, null, msg, window.__deckLastCmd !== undefined
            ? h('button', { className: 'dk-mini', style: { marginLeft: 8 }, onClick: copyCmd }, '复制命令') : null)
          : null,
        cards === null ? h(Note, null, '加载中…') : null,
        cards !== null && cards.length === 0 ? h(Note, null, '还没有任务卡（TASK.md）——建一张，再「发给 zcode」') : null,
        h('div', { className: 'dk-grid' },
          (cards ?? []).map((c) => {
            const meta = STATUS_META[c.status] ?? STATUS_META.queued
            return h('div', { key: c.id, className: 'dk-card task ' + meta[1] },
              h('div', { className: 'dk-card-title' }, c.title),
              h('div', { className: 'dk-card-sub' }, c.id + ' · ' + (TYPE_LABEL[c.type] ?? c.type) + ' · ' + (c.created || '') + (c.engine !== '' ? ' · ' + c.engine : '')),
              h('span', { className: 'dk-badge ' + meta[1] }, meta[0]),
              (c.acceptance ?? []).length > 0
                ? h('ul', { className: 'dk-task-acc' }, c.acceptance.slice(0, 5).map((a, i) => h('li', { key: i }, a)))
                : null,
              h('div', { className: 'dk-card-actions' },
                c.status === 'queued' ? h('button', { className: 'dk-mini', onClick: dispatch }, '🚀 发给 zcode') : null,
                c.status === 'running' ? h('span', { className: 'dk-fine' }, 'zcode 工作中…') : null,
                c.status === 'review' ? h('button', { className: 'dk-mini', onClick: () => markDone(c.id) }, '✔ 审毕标完成') : null,
                h('button', { className: 'dk-mini', onClick: reload }, '↻'),
              ))
          }),
        ),
      )
    }

    const KB_TABS = [['search', '🔍 搜索'], ['browse', '📚 四库'], ['ideas', '💡 点子'], ['tasks', '📋 任务'], ['review', '🔁 复盘']]

    function KnowledgeDesk() {
      const [tab, setTab] = useState('search')
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' }, KB_TABS.map(([id, label]) =>
          h('button', { key: id, className: tab === id ? 'on' : '', onClick: () => setTab(id) }, label))),
        h('div', { className: 'dk-deskmain' },
          tab === 'search' ? h(KbSearch)
          : tab === 'browse' ? h(FsBrowse, { root: 'kb', base: '', layers: LAYERS })
          : tab === 'ideas' ? h(KbIdeas)
          : tab === 'tasks' ? h(TaskBoard, { projectId: 'builtin-kb' })
          : h(KbReview)),
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

    // ── 会话镜像（worktable 精华：快照 + 订阅，防御式多形状）──
    let deckCtx = null
    const sessionsStore = { ready: false, ids: [], byId: {}, current: null }
    function sessTitle(s) { return (s && (s.displayTitle || s.title)) || (s && s.id ? String(s.id).slice(0, 12) : '会话') }
    function eatSessions(snap) {
      try {
        if (snap === null || typeof snap !== 'object') return
        let ids = [], byId = {}, current = null
        if (Array.isArray(snap)) {
          ids = snap.map((s) => s && (s.id ?? s.sessionId)).filter(Boolean)
          byId = {}
          for (const s of snap) { if (s) byId[s.id ?? s.sessionId] = s }
        } else {
          if (Array.isArray(snap.ids)) ids = ids.concat(snap.ids)
          if (snap.byId && typeof snap.byId === 'object') byId = snap.byId
          if (typeof snap.current === 'string') current = snap.current
        }
        sessionsStore.ids = ids
        sessionsStore.byId = byId
        sessionsStore.current = current
        sessionsStore.ready = true
        try { window.__dkSessions = sessionsStore } catch {}
        notify()
      } catch { /* 形状不符就保持现状 */ }
    }
    function initSessions(ctx) {
      try {
        const s = ctx && ctx.sessions
        if (!s) return
        const list = s.list
        if (list && typeof list.getSnapshot === 'function') eatSessions(list.getSnapshot())
        else if (list && typeof list.value !== 'undefined') eatSessions(list.value)
        if (list && typeof list.subscribe === 'function') { try { list.subscribe(eatSessions) } catch {} }
        else if (typeof s.subscribe === 'function') { try { s.subscribe(eatSessions) } catch {} }
      } catch { /* 无会话 API 则跳过绑定功能 */ }
    }
    function openSession(id) { try { deckCtx && deckCtx.sessions && deckCtx.sessions.open && deckCtx.sessions.open(id) } catch {} }
    async function createSessionFor(folder) {
      if (!(deckCtx && deckCtx.sessions && typeof deckCtx.sessions.create === 'function')) throw new Error('此 dsh 版本不支持从插件建会话')
      return await deckCtx.sessions.create({ cwd: folder })
    }

    // ── deck 状态 / 根映射（模块级，供左栏与控制室共享）──
    const stateStore = { loaded: false, projects: [] }
    function loadState() {
      API.state().then((j) => {
        stateStore.projects = Array.isArray(j && j.projects) ? j.projects : []
        stateStore.loaded = true
        notify()
      }).catch(() => {})
    }
    const rootsStore = { map: null }
    function loadRoots() {
      API.roots().then((j) => {
        if (j && j.ok && j.roots && typeof j.roots === 'object') { rootsStore.map = j.roots; notify() }
      }).catch(() => {})
    }
    function normPath(p) { return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() }
    function resolveAlias(folder) {
      if (rootsStore.map === null) return null
      const f = normPath(folder)
      for (const [alias, path] of Object.entries(rootsStore.map)) {
        const r = normPath(path)
        if (f === r) return { root: alias, rel: '' }
        if (f.startsWith(r + '/')) return { root: alias, rel: f.slice(r.length + 1) }
      }
      return null
    }

    // ── 会话绑定小组件 ──
    function SessionPicker({ project, onDone }) {
      const rows = sessionsStore.ids
        .map((id) => sessionsStore.byId[id])
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        .slice(0, 10)
      const bind = (sid) => {
        API.projectUpdate(project.id, { bindSession: sid }).then(() => { loadState() }).catch(() => {})
        openSession(sid)
        onDone()
      }
      const fresh = async () => {
        try {
          const sid = await createSessionFor(project.folder)
          API.projectUpdate(project.id, { bindSession: sid })
          openSession(sid)
          onDone()
        } catch (e) { onDone(String(e instanceof Error ? e.message : e)) }
      }
      return h('div', { className: 'dk-picker' },
        h('div', { className: 'dk-picker-head' }, '选择要绑定的会话'),
        rows.length === 0 ? h(Note, null, '没抓到会话列表（可能此 dsh 版本不开放）') : null,
        rows.map((s) =>
          h('button', { key: s.id, className: 'dk-sessrow' + (s.id === sessionsStore.current ? ' cur' : ''), onClick: () => bind(s.id), title: s.cwd || '' },
            h('span', { className: 'dk-sessrow-t' }, sessTitle(s)),
            h('span', { className: 'dk-sessrow-c' }, s.cwd || ''))),
        h('button', { className: 'dk-mini', onClick: fresh }, '＋ 新建会话并绑定（cwd=项目夹）'),
      )
    }

    // ── 新建工作台向导 ──
    const TEMPLATES = [['blank', '空白容器'], ['kb', '知识调研型'], ['media', '自媒体型']]
    function NewProjectWizard({ onClose, onCreated }) {
      const [name, setName] = useState('')
      const [icon, setIcon] = useState('🗂️')
      const [folder, setFolder] = useState('')
      const [template, setTemplate] = useState('blank')
      const [msg, setMsg] = useState(null)
      useEffect(() => {
        if (folder === '' && rootsStore.map !== null) {
          const c = rootsStore.map.content
          if (c) setFolder(c.replace(/\\+$/, '').replace(/\\/g, '/') + '/bench')
        }
      }, [rootsStore.map])
      const slug = () => name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bench'
      const suggest = () => { if (rootsStore.map !== null) setFolder(rootsStore.map.content.replace(/\\+$/, '').replace(/\\/g, '/') + '/' + slug()) }
      const submit = (e) => {
        e.preventDefault()
        if (name.trim() === '') { setMsg('名称必填'); return }
        API.projectCreate({ name, icon, folder: folder.replace(/\\/g, '/'), template }).then((j) => {
          if (!j.ok) { setMsg('失败：' + j.error); return }
          loadState()
          onCreated(j.project)
        }).catch((e) => setMsg(String(e)))
      }
      return h('div', { className: 'dk-modal-back', onClick: (e) => { if (e.target.className === 'dk-modal-back') onClose() } },
        h('form', { className: 'dk-modal', onSubmit: submit },
          h('div', { className: 'dk-modal-title' }, '新建工作台'),
          h('div', { className: 'dk-field' },
            h('label', null, '名称'),
            h('input', { value: name, onChange: (e) => setName(e.target.value), placeholder: '如：竞品周报台', autoFocus: true })),
          h('div', { className: 'dk-field-row' },
            h('div', { className: 'dk-field' },
              h('label', null, '图标'),
              h('input', { value: icon, onChange: (e) => setIcon(e.target.value), size: 4 })),
            h('div', { className: 'dk-field' },
              h('label', null, '模板'),
              h('select', { value: template, onChange: (e) => setTemplate(e.target.value) },
                TEMPLATES.map(([v, l]) => h('option', { key: v, value: v }, l))))),
          h('div', { className: 'dk-field' },
            h('label', null, '文件夹（必须在注册根内，会自动建 AGENTS.md/README）'),
            h('input', { value: folder, onChange: (e) => setFolder(e.target.value), placeholder: 'D:/coding/content/…' }),
            h('button', { type: 'button', className: 'dk-mini', style: { alignSelf: 'flex-start', marginTop: 4 }, onClick: suggest }, '按名称生成')),
          msg !== null ? h(Err, null, msg) : null,
          h('div', { className: 'dk-modal-actions' },
            h('button', { type: 'button', className: 'dk-ghost', onClick: onClose }, '取消'),
            h('button', { type: 'submit' }, '创建')),
        ),
      )
    }

    // ── 控制室：项目卡墙 + 会话绑定 + 统一看板 ──
    const BOARD_COLS = [['queued', '⏳ 待接单'], ['running', '🏃 进行中'], ['review', '👀 待审阅'], ['done', '✅ 完成']]

    function ControlRoom() {
      const [, force] = useState(0)
      const [tab, setTab] = useState('projects')
      const [boards, setBoards] = useState(null)
      const [wizard, setWizard] = useState(false)
      const [picking, setPicking] = useState(null)
      const [msg, setMsg] = useState(null)
      useEffect(() => {
        if (!stateStore.loaded) loadState()
        if (rootsStore.map === null) loadRoots()
        const t = setInterval(() => { API.boards().then((j) => { if (j && j.ok) setBoards(j.boards) }).catch(() => {}) }, 5000)
        API.boards().then((j) => { if (j && j.ok) setBoards(j.boards) }).catch(() => {})
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        return () => { clearInterval(t); listeners.delete(fn) }
      }, [])
      const projects = stateStore.projects
      const countsOf = (id, st) => {
        const b = (boards ?? []).find((x) => x.id === id)
        return b ? b.cards.filter((c) => c.status === st).length : 0
      }
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' },
          h('button', { className: tab === 'projects' ? 'on' : '', onClick: () => setTab('projects') }, '🗂️ 项目'),
          h('button', { className: tab === 'board' ? 'on' : '', onClick: () => setTab('board') }, '📊 统一看板')),
        h('div', { className: 'dk-deskmain' },
          msg !== null ? h(Note, null, msg) : null,
          tab === 'projects'
            ? h('div', { className: 'dk-grid wide' },
                projects.map((p) =>
                  h('div', { key: p.id, className: 'dk-card room' + (p.hidden ? ' hidden' : '') },
                    h('div', { className: 'dk-room-head' },
                      h('span', { className: 'dk-room-icon' }, p.icon || '📁'),
                      h('span', { className: 'dk-card-title' }, p.name),
                      p.id.startsWith('builtin-') ? h('span', { className: 'dk-tag' }, '内置') : null),
                    h('div', { className: 'dk-card-sub' }, p.folder || '（未绑文件夹）'),
                    h('div', { className: 'dk-counts' },
                      h('span', null, '⏳ ' + countsOf(p.id, 'queued')),
                      h('span', null, '🏃 ' + countsOf(p.id, 'running')),
                      h('span', null, '👀 ' + countsOf(p.id, 'review')),
                      h('span', null, '✅ ' + countsOf(p.id, 'done'))),
                    p.bindSession
                      ? h('button', { className: 'dk-bind cur', title: '点按切换到该会话', onClick: () => openSession(p.bindSession) },
                          '🔗 ' + sessTitle(sessionsStore.byId[p.bindSession]))
                      : h('button', { className: 'dk-bind', onClick: () => setPicking(picking === p.id ? null : p.id) }, '🔗 绑定会话'),
                    picking === p.id ? h(SessionPicker, {
                      project: p,
                      onDone: (e) => { setPicking(null); if (typeof e === 'string') setMsg(e) },
                    }) : null,
                    h('div', { className: 'dk-card-actions' },
                      h('button', { className: 'dk-mini', onClick: () => { goProject(p.id) } }, '打开 →'),
                      p.id.startsWith('builtin-')
                        ? h('button', { className: 'dk-mini', onClick: () => { API.projectUpdate(p.id, { hidden: !p.hidden }); setTimeout(loadState, 300) } }, p.hidden ? '取消隐藏' : '隐藏')
                        : h('button', { className: 'dk-mini danger', onClick: () => { if (window.confirm('删除工作台「' + p.name + '」？（只解除注册，不动磁盘文件）')) post('/api/deck/project/delete', { id: p.id }).then(() => { loadState() }) } }, '删除')),
                  )),
                h('div', { className: 'dk-card room add', role: 'button', tabIndex: 0, onClick: () => setWizard(true) },
                  h('div', { className: 'dk-room-icon' }, '＋'),
                  h('div', { className: 'dk-card-title' }, '新建工作台'),
                  h('div', { className: 'dk-card-sub' }, '名称/图标/文件夹/模板')))
            : h(BoardView, { boards: boards ?? [] }),
          wizard ? h(NewProjectWizard, {
            onClose: () => setWizard(false),
            onCreated: (p) => { setWizard(false); setMsg('已创建 ✓ ' + p.name + '（脚手架已写入）'); goProject(p.id) },
          }) : null,
        ),
      )
    }

    function BoardView({ boards }) {
      return h('div', { className: 'dk-board' },
        BOARD_COLS.map(([st, label]) =>
          h('div', { key: st, className: 'dk-board-col' },
            h('div', { className: 'dk-board-colhead' }, label),
            boards.flatMap((b) => b.cards.filter((c) => c.status === st).map((c) => ({ b, c })))
              .map(({ b, c }) =>
                h('button', { key: b.id + '/' + c.id, className: 'dk-chip-task', onClick: () => { goProject(b.id) }, title: c.title + ' · ' + b.name },
                  h('span', { className: 'dk-chip-task-t' }, c.title),
                  h('span', { className: 'dk-chip-task-p' }, (b.icon || '📁') + ' ' + b.name)))),
        ),
      )
    }

    // ── 通用项目台面（自定义工作台：任务 + 文件）──
    function GenericDesk({ project }) {
      const [tab, setTab] = useState('tasks')
      const loc = resolveAlias(project.folder)
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' },
          h('button', { className: tab === 'tasks' ? 'on' : '', onClick: () => setTab('tasks') }, '📋 任务'),
          h('button', { className: tab === 'files' ? 'on' : '', onClick: () => setTab('files') }, '📚 文件'),
          loc === null ? h('span', { className: 'dk-fine', style: { alignSelf: 'center', marginLeft: 6 } }, '⚠ 文件夹不在注册根内，文件页不可用') : null),
        h('div', { className: 'dk-deskmain' },
          tab === 'tasks'
            ? h(TaskBoard, { projectId: project.id })
            : loc !== null ? h(FsBrowse, { root: loc.root, base: loc.rel, layers: null })
              : h(Note, null, '此项目文件夹不在 kb/content 根内，无法浏览')),
      )
    }

    // ── 工作台外壳 ──
    const APPS = [['kb', '🧠', '知识调研台'], ['media', '🎬', '自媒体台']]
    let navigateApp = null
    function goProject(id) {
      if (!isOpen()) setOpen(true)
      if (navigateApp !== null) navigateApp(id === 'builtin-kb' ? 'kb' : id === 'builtin-media' ? 'media' : 'p:' + id)
    }

    let openState = null
    let everOpened = false
    const listeners = new Set()
    function notify() { for (const fn of listeners) { try { fn() } catch {} } }
    function isOpen() { return openState ?? false }
    function setOpen(v) {
      openState = v
      if (v) everOpened = true
      try { localStorage.setItem(LS_OPEN, v ? '1' : '0') } catch {}
      notify()
    }

    function Rail({ app, setApp }) {
      const projects = stateStore.loaded ? stateStore.projects.filter((p) => !p.hidden) : []
      const userProjects = projects.filter((p) => !p.id.startsWith('builtin-'))
      return h('div', { className: 'dk-rail' },
        h('div', { className: 'dk-rail-brand' }, 'DECK'),
        APPS.map(([id, icon, label]) =>
          h('button', { key: id, className: 'dk-rail-btn' + (app === id ? ' on' : ''), title: label, onClick: () => setApp(id) },
            h('span', { className: 'dk-rail-icon' }, icon),
            h('span', { className: 'dk-rail-label' }, label))),
        userProjects.length > 0 ? h('div', { className: 'dk-rail-sep' }) : null,
        userProjects.map((p) =>
          h('button', { key: p.id, className: 'dk-rail-btn' + (app === 'p:' + p.id ? ' on' : ''), title: p.name, onClick: () => setApp('p:' + p.id) },
            h('span', { className: 'dk-rail-icon' }, p.icon || '📁'),
            h('span', { className: 'dk-rail-label' }, p.name.slice(0, 6)))),
        h('div', { className: 'dk-rail-fill' }),
        h('button', { className: 'dk-rail-btn' + (app === 'room' ? ' on' : ''), title: '控制室', onClick: () => setApp('room') },
          h('span', { className: 'dk-rail-icon' }, '🖥️'),
          h('span', { className: 'dk-rail-label' }, '控制室')),
        h('button', { className: 'dk-rail-btn close', title: '收起工作台', onClick: () => setOpen(false) },
          h('span', { className: 'dk-rail-icon' }, '»')),
      )
    }

    function Workspace() {
      const [app, setApp] = useState('kb')
      const [, force] = useState(0)
      useEffect(() => {
        navigateApp = setApp
        if (!stateStore.loaded) loadState()
        if (rootsStore.map === null) loadRoots()
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        return () => { listeners.delete(fn); if (navigateApp === setApp) navigateApp = null }
      }, [])
      if (openState === null) { try { openState = localStorage.getItem(LS_OPEN) === '1' } catch { openState = false } }
      if (openState === true) everOpened = true
      if (!isOpen()) {
        return everOpened
          ? h('button', { className: 'dk-tile', title: '展开工作台', onClick: () => setOpen(true) }, '🗂️')
          : null
      }
      const proj = app.startsWith('p:') ? (stateStore.projects.find((p) => p.id === app.slice(2)) ?? null) : null
      return h('div', { className: 'dk-shell' },
        h(Rail, { app, setApp }),
        h('div', { className: 'dk-main' },
          app === 'kb' ? h(KnowledgeDesk)
          : app === 'media' ? h(MediaDesk)
          : app === 'room' ? h(ControlRoom)
          : proj !== null ? h(GenericDesk, { project: proj })
          : h('div', { className: 'dk-empty' }, h('div', { className: 'dk-empty-title' }, '项目不存在（可能已删除）'))),
      )
    }

    function injectStyle() {
      if (document.getElementById('dsh-deck-style')) return
      const css = `
.dk-shell{position:fixed;inset:0;z-index:60;display:flex;color-scheme:dark;
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
.dk-rail-label{font-size:9px;transform:scale(.92);max-width:44px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-rail-fill{flex:1;}
.dk-rail-sep{width:26px;height:1px;background:var(--color-border-1,#2a2e37);margin:6px 0;}
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
.dk-grid.wide{grid-template-columns:repeat(auto-fill,minmax(240px,1fr));}
.dk-card{background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:12px;
  padding:12px 14px;cursor:pointer;transition:border-color .15s,transform .1s;position:relative;}
.dk-card:hover{border-color:var(--dk-accent,#5b6cff);transform:translateY(-1px);}
.dk-card.dir{opacity:.92;}
.dk-card.picked{opacity:.55;}
.dk-card-title{font-weight:600;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-card-sub{font-size:11px;opacity:.5;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-card-snip{font-size:12px;opacity:.8;margin-top:6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.dk-card-snip mark{background:color-mix(in srgb,var(--dk-accent,#5b6cff) 35%,transparent);color:inherit;border-radius:2px;padding:0 1px;}
.dk-card-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;}
.dk-mini{background:var(--color-bg-2,#1b1e26);color:var(--dk-accent,#5b6cff);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:8px;font:11.5px/1.6 system-ui;cursor:pointer;padding:2px 10px;}
.dk-mini:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-mini.danger{color:#f87171;}
.dk-mini.danger:hover{border-color:#f87171;}
.dk-ghost{background:none;border:1px solid var(--color-border-1,#2a2e37);color:inherit;border-radius:10px;
  font:inherit;cursor:pointer;padding:9px 16px;}
.dk-ghost:hover{border-color:var(--dk-accent,#5b6cff);color:var(--dk-accent,#5b6cff);}
.dk-room-icon{font-size:24px;}
.dk-room-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.dk-room-head .dk-card-title{margin-bottom:0;flex:1;}
.dk-tag{font-size:10px;border:1px solid var(--color-border-1,#2a2e37);border-radius:999px;padding:0 8px;opacity:.6;}
.dk-room-status{font-size:11px;opacity:.45;margin-top:6px;}
.dk-card.room{cursor:default;text-align:left;display:flex;flex-direction:column;gap:6px;}
.dk-card.room.add{border-style:dashed;opacity:.6;cursor:pointer;justify-content:center;align-items:flex-start;}
.dk-card.room.add:hover{opacity:1;border-color:var(--dk-accent,#5b6cff);}
.dk-card.hidden{opacity:.45;}
.dk-counts{display:flex;gap:10px;font-size:11.5px;opacity:.75;flex-wrap:wrap;}
.dk-bind{align-self:flex-start;background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);border-radius:8px;
  color:inherit;font:11.5px/1.6 system-ui;cursor:pointer;padding:2px 10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-bind.cur{color:#34d399;border-color:#34d39955;}
.dk-bind:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-picker{background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);border-radius:10px;
  padding:8px;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;}
.dk-picker-head{font-size:11px;opacity:.55;margin-bottom:2px;}
.dk-sessrow{display:flex;flex-direction:column;gap:0;background:none;border:none;color:inherit;text-align:left;
  border-radius:8px;padding:5px 8px;cursor:pointer;font:inherit;}
.dk-sessrow:hover{background:var(--color-bg-3,#232732);}
.dk-sessrow.cur{box-shadow:inset 0 0 0 1px var(--dk-accent,#5b6cff);}
.dk-sessrow-t{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-sessrow-c{font-size:10.5px;opacity:.45;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
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
.dk-tile{position:fixed;right:18px;bottom:18px;z-index:59;width:44px;height:44px;border-radius:12px;
  background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);color:inherit;
  font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.7;}
.dk-tile:hover{opacity:1;border-color:var(--dk-accent,#5b6cff);}
.dk-taskform{display:flex;flex-direction:column;gap:6px;max-width:640px;background:var(--color-bg-1,#14161c);
  border:1px solid var(--color-border-1,#2a2e37);border-radius:12px;padding:12px;}
.dk-taskform input,.dk-taskform textarea,.dk-taskform select{background:var(--color-bg-2,#1b1e26);color:inherit;
  border:1px solid var(--color-border-1,#2a2e37);border-radius:8px;padding:8px 10px;font:inherit;outline:none;}
.dk-taskform input:focus,.dk-taskform textarea:focus{border-color:var(--dk-accent,#5b6cff);}
.dk-taskform textarea{resize:vertical;min-height:44px;}
.dk-taskform-row{display:flex;gap:6px;}
.dk-taskform-row button{flex-shrink:0;}
.dk-taskform button[type=submit]{background:var(--dk-accent,#5b6cff);color:#fff;border:none;border-radius:8px;
  padding:8px 18px;cursor:pointer;font:inherit;font-weight:600;}
.dk-badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 10px;margin-top:6px;
  border:1px solid var(--color-border-1,#2a2e37);opacity:.9;}
.dk-badge.wait{color:#fbbf24;border-color:#fbbf2444;}
.dk-badge.run{color:#60a5fa;border-color:#60a5fa44;}
.dk-badge.rev{color:#c084fc;border-color:#c084fc44;}
.dk-badge.ok{color:#34d399;border-color:#34d39944;}
.dk-badge.bad{color:#f87171;border-color:#f8717144;}
.dk-task-acc{margin:6px 0 0;padding-left:1.3em;font-size:11.5px;opacity:.7;}
.dk-task-acc li{margin:1px 0;}
.dk-card.task{cursor:default;}
.dk-modal-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:70;display:flex;align-items:center;justify-content:center;}
.dk-modal{width:min(440px,92vw);background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.5);}
.dk-modal-title{font-weight:700;font-size:14px;}
.dk-field{display:flex;flex-direction:column;gap:4px;font-size:12px;}
.dk-field label{opacity:.6;}
.dk-field input,.dk-field select{background:var(--color-bg-2,#1b1e26);color:inherit;
  border:1px solid var(--color-border-1,#2a2e37);border-radius:8px;padding:7px 10px;font:inherit;outline:none;}
.dk-field input:focus,.dk-field select:focus{border-color:var(--dk-accent,#5b6cff);}
.dk-field-row{display:flex;gap:10px;}
.dk-field-row .dk-field{flex:1;}
.dk-modal-actions{display:flex;justify-content:flex-end;gap:8px;}
.dk-modal-actions button[type=submit]{background:var(--dk-accent,#5b6cff);color:#fff;border:none;border-radius:10px;
  padding:8px 20px;cursor:pointer;font:inherit;font-weight:600;}
.dk-board{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:10px;align-items:start;}
.dk-board-col{background:color-mix(in srgb,var(--color-bg-1,#14161c) 60%,transparent);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px;min-height:140px;}
.dk-board-colhead{font-size:12px;font-weight:600;opacity:.7;padding:2px 4px 4px;}
.dk-chip-task{display:flex;flex-direction:column;gap:2px;background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:10px;color:inherit;text-align:left;font:inherit;cursor:pointer;padding:7px 10px;}
.dk-chip-task:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-chip-task-t{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-chip-task-p{font-size:10.5px;opacity:.5;}
`
      const el = document.createElement('style')
      el.id = 'dsh-deck-style'
      el.textContent = css
      document.head.appendChild(el)
    }

    const inject = ['slots', 'sessions']
    function apply(ctx) {
      deckCtx = ctx
      injectStyle()
      initSessions(ctx)
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
