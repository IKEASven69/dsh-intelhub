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
      write: (root, path, content) => post('/api/deck/fs/write', { root, path, content }),
      state: () => get('/api/deck/state'),
      roots: () => get('/api/deck/roots'),
      ideas: () => get('/api/deck/ideas'),
      capture: (text) => post('/api/deck/idea/capture', { text }),
      adopt: (file, to) => post('/api/deck/idea/adopt', { file, to }),
      insights: () => get('/api/deck/insights'),
      quickview: () => post('/api/deck/kb/quickview', {}),
      msgList: () => get('/api/deck/messages'),
      msgAdd: (x) => post('/api/deck/messages', x),
      msgReply: (id, reply) => post('/api/deck/message/reply', { id, reply }),
      msgDraft: (id) => post('/api/deck/message/reply', { id, reply: '', draft: true }),
      msgDelete: (id) => post('/api/deck/message/delete', { id }),
      tasks: (project) => post('/api/deck/tasks', { project }),
      boards: () => post('/api/deck/tasks', {}),
      taskCreate: (project, title, type, acceptance, body) => post('/api/deck/task/create', { project, title, type, acceptance, body }),
      taskStatus: (project, id, status) => post('/api/deck/task/status', { project, id, status }),
      dispatch: (project) => post('/api/deck/task/dispatch', { project }),
      reviewResult: (project, id) => post('/api/deck/review/result', { project, id }),
      approve: (project, id, picks) => post('/api/deck/review/approve', { project, id, picks }),
      contentList: () => post('/api/deck/content/list', {}),
      contentCreate: (title, type, platforms) => post('/api/deck/content/create', { title, type, platforms }),
      contentStatus: (slug, status) => post('/api/deck/content/status', { slug, status }),
      contentHandoff: (slug) => post('/api/deck/content/handoff', { slug }),
      prefill: (slug, platform) => post('/api/deck/publish/prefill', { slug, platform }),
      publishRecord: (slug, platform, link) => post('/api/deck/publish/record', { slug, platform, link }),
      launcherGet: () => get('/api/deck/launcher'),
      launcherSet: (x) => post('/api/deck/launcher', x),
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

    // ── SVG 图标系统（Lucide 风格线性图标 + CSS 动画）──
    const ICON_PATHS = {
      hub: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
      content: 'M4 4h16v2H4zM4 9h16v2H4zM4 14h10v2H4zM4 19h7v2H4z',
      kb: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z M12 20c-4.4 0-8-3.6-8-8 0-1.8.6-3.5 1.7-4.8C7 5.7 9.4 4.7 12 4.7s5 1 6.3 2.5C19.4 8.5 20 10.2 20 12c0 4.4-3.6 8-8 8z',
      research: 'M11 4a7 7 0 0 1 7 7 7 7 0 0 1-7 7 7 7 0 0 1-7-7 7 7 0 0 1 7-7zM21 21l-4.35-4.35',
      msg: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
      room: 'M3 3h18v14H3zM8 21h8M12 17v4',
      search: 'M11 4a7 7 0 0 1 7 7 7 7 0 0 1-7 7 7 7 0 0 1-7-7 7 7 0 0 1 7-7zM21 21l-4.35-4.35',
      library: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
      ideas: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z',
      tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
      review: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
      lessons: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
      graph: 'M12 2a10 10 0 1 0 10 10h-10V2z',
      send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
      terminal: 'M4 17l6-6-6-6M12 19h8',
      chat: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z',
      publish: 'M3 11l18-5v12L3 14v-3zM11.6 16.8a3 3 0 1 1-5.8-1.6',
      play: 'M5 3l14 9-14 9V3z',
      read: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
      plus: 'M12 5v14M5 12h14',
      trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
      edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z',
      check: 'M20 6L9 17l-5-5',
      warn: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
      close: 'M18 6L6 18M6 6l12 12',
      chevronR: 'M9 18l6-6-6-6',
      chevronL: 'M15 18l-6-6 6-6',
      split: 'M3 3h18v18H3zM12 3v18',
      copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
      settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
      refresh: 'M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15',
      dot: 'M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
      clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
      eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
      file: 'M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M13 2v7h7',
      folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
      arrowUp: 'M12 19V5M5 12l7-7 7 7',
      arrowDown: 'M12 5v14M19 12l-7 7-7-7',
      bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
      link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
      user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
      calendar: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
      grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    }
    function Icon({ name, size = 18, className = '', style = {} }) {
      const d = ICON_PATHS[name] || ICON_PATHS.dot
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        className: 'dk-icon-svg ' + className, style,
        dangerouslySetInnerHTML: { __html: '<path d="' + d + '"/>' } })
    }

    function Note({ children }) { return h('div', { className: 'dk-note' }, children) }
    function Err({ children }) { return h('div', { className: 'dk-note dk-err' }, children) }

    function Preview({ root, path, onBack, title }) {
      const [text, setText] = useState(null)
      const [err, setErr] = useState(null)
      const [editing, setEditing] = useState(false)
      const [editText, setEditText] = useState('')
      const [saving, setSaving] = useState(false)
      const [saveMsg, setSaveMsg] = useState(null)
      const isMd = path.endsWith('.md') || path.endsWith('.markdown')
      useEffect(() => {
        let alive = true
        setText(null); setErr(null); setEditing(false); setSaveMsg(null)
        API.read(root, path).then((j) => {
          if (!alive) return
          if (j.ok) { setText(j.content); setEditText(j.content) } else { setErr(j.error) }
        }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [root, path])
      const doSave = async () => {
        setSaving(true); setSaveMsg(null)
        try {
          const j = await API.write(root, path, editText)
          if (j.ok) { setText(editText); setEditing(false); setSaveMsg('已保存 ✓') } else { setSaveMsg('保存失败：' + j.error) }
        } catch (e) { setSaveMsg('保存失败：' + String(e)) }
        setSaving(false)
      }
      return h('div', { className: 'dk-preview' },
        h('div', { className: 'dk-preview-head' },
          h('button', { className: 'dk-back', onClick: onBack }, '‹ 返回'),
          h('span', { className: 'dk-path' }, title || path),
          text !== null ? h('button', { className: 'dk-chip', style: { marginLeft: 4 }, title: '在浮窗中打开（可拖拽多开）', onClick: () => winStore.open({ title: title || path, root, path }) }, '浮窗') : null,
          text !== null && isMd ? h('button', { className: 'dk-chip', style: { marginLeft: 8 }, onClick: () => { if (editing) { setEditText(text); setSaveMsg(null) } setEditing(!editing) }, disabled: saving }, editing ? '预览' : '编辑') : null,
          editing ? h('button', { className: 'dk-chip', style: { marginLeft: 4 }, onClick: doSave, disabled: saving }, saving ? '保存中…' : '保存') : null,
          editing ? h('button', { className: 'dk-chip', style: { marginLeft: 4 }, onClick: () => { setEditing(false); setEditText(text); setSaveMsg(null) }, disabled: saving }, '取消') : null),
        saveMsg !== null ? h('div', { className: saveMsg.startsWith('已保存') ? 'dk-note' : 'dk-err', style: { fontSize: 12.5 } }, saveMsg) : null,
        err !== null ? h(Err, null, '读取失败：' + err) : null,
        text === null && err === null ? h(Note, null, '加载中…') : null,
        text !== null && !editing ? h('div', { className: 'dk-md', dangerouslySetInnerHTML: { __html: mdToHtml(text) } }) : null,
        editing ? h('textarea', { value: editText, onChange: (e) => setEditText(e.target.value), rows: 18, style: { width: '100%', minHeight: 320, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.6, padding: 12, borderRadius: 8, border: '1px solid var(--color-border-1,#2a2e37)', background: 'var(--color-bg-1,#14161c)', color: 'inherit', resize: 'vertical' } }) : null,
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
    const LAYERS = [['', '根目录'], ['collections', '① 采集原料'], ['research', '② 事实核查'], ['insights', '③ 判断沉淀'], ['skills', '④ 方法论'], ['ideas', '⑤ 点子池']]

    function FsBrowse({ root, base, layers }) {
      const [dir, setDir] = useState(base)
      const [entries, setEntries] = useState(null)
      const [file, setFile] = useState(null)
      const [err, setErr] = useState(null)
      const [split, setSplit] = useState(false)
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
      if (split) {
        return h('div', { style: { display: 'flex', gap: 12, flex: 1, minHeight: 0 } },
          h('div', { style: { width: 340, flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { className: 'dk-toolbar', style: { marginBottom: 4 } },
              h('button', { className: 'dk-chip', onClick: () => setSplit(false) }, '⇔ 单栏'),
              h('span', { className: 'dk-fine', style: { alignSelf: 'center', marginLeft: 6 } }, dir || '根')),
            (entries ?? []).map((e) =>
              h('div', {
                key: e.name,
                style: { padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                  background: file === (dir === '' ? e.name : dir + '/' + e.name) ? 'color-mix(in srgb, var(--dk-accent,#5b6cff) 12%, transparent)' : 'var(--color-bg-1,#14161c)',
                  border: '1px solid var(--color-border-1,#2a2e37)', fontWeight: e.type === 'dir' ? 600 : 400 },
                onClick: () => { const next = dir === '' ? e.name : dir + '/' + e.name; if (e.type === 'dir') { setDir(next); setFile(null) } else { setFile(next) } },
              }, (e.type === 'dir' ? '📁 ' : '📄 ') + e.name)),
          ),
          h('div', { style: { flex: 1, minWidth: 0, overflowY: 'auto' } },
            file !== null
              ? h(Preview, { root, path: file, title: file.split('/').pop(), onBack: () => setFile(null) })
              : h(Note, null, '← 点文件预览')),
        )
      }
      if (file !== null) return h(Preview, { root, path: file, title: file.split('/').pop(), onBack: () => setFile(null) })
      return h('div', { className: 'dk-col' },
        h('div', { className: 'dk-toolbar' },
          h('button', { className: 'dk-chip', onClick: () => setSplit(true), title: '左列表+右预览' }, '⇔ 分屏'),
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
                idea.status === 'seed' ? '种子' : idea.status === 'incubating' ? '孵化中' : '✅ 已采纳',
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
    function KbGraph() {
      const [html, setHtml] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        API.read('kb', 'docs/graph.html').then((j) => {
          if (!alive) return
          if (j.ok) setHtml(j.content); else setErr(j.error)
        }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [])
      if (err !== null) return h(Err, null, '读取失败：' + err + '（跑 scripts/graph.ps1 生成）')
      if (html === null) return h(Note, null, '加载图谱中…')
      return h('div', { style: { flex: 1, minHeight: 0, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--color-border-1,#2a2e37)' } },
        h('iframe', { sandbox: 'allow-scripts', srcDoc: html, style: { width: '100%', height: '100%', border: 'none', background: '#0d1117' } }))
    }

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

    function TaskBoard({ projectId, onGoReview }) {
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
      const sendToSession = async () => {
        const queued = (cards ?? []).find((c) => c.status === 'queued')
        if (queued === undefined) { setMsg('没有待接单的卡（queued）'); return }
        const proj = stateStore.projects.find((p) => p.id === projectId)
        const sid = (proj && proj.bindSession) || sessionsStore.current
        if (sid === undefined) { setMsg('没有绑定会话，先在控制室绑定'); return }
        const text = [
          '【dsh-deck 任务派发】',
          '任务：' + queued.title,
          '类型：' + (TYPE_LABEL[queued.type] || queued.type),
          queued.acceptance.length > 0 ? '验收：\n' + queued.acceptance.map((a, i) => (i + 1) + '. ' + a).join('\n') : '',
          '\n协议：读项目 TASK.md 找 status:queued 的卡→改 running→干活→写 RESULT.md（含 ## 判断 + ## 来源）→改 review。',
          '完成后总台会出现审阅待办。',
        ].filter(Boolean).join('\n')
        try {
          setMsg('投递中…')
          await promptIntoSession(sid, text)
          openSession(sid)
          setMsg('✓ 已派发到会话（右侧可见 agent 开始工作）')
        } catch (e) { setMsg('失败：' + String((e && e.message) || e)) }
      }
      const markDone = (id) => API.taskStatus(projectId, id, 'done').then(() => reload())
      return h('div', { className: 'dk-col' },
        h('form', { className: 'dk-taskform', onSubmit: create },
          h('input', { value: title, onChange: (e) => setTitle(e.target.value), placeholder: '任务题目（如：调研 xxx 的现状与反方观点）', 'aria-label': '任务题目' }),
          h('select', { value: type, onChange: (e) => setType(e.target.value), 'aria-label': '任务类型' },
            Object.keys(TYPE_LABEL).map((t) => h('option', { key: t, value: t }, TYPE_LABEL[t]))),
          h('textarea', { value: acc, onChange: (e) => setAcc(e.target.value), rows: 2, placeholder: '验收条目（一行一条，可留空走默认：产出带来源的调研稿）', 'aria-label': '验收条目' }),
          h('button', { type: 'submit' }, '建卡')),
        h('div', { className: 'dk-toolbar' },
          h('button', { className: 'dk-ghost', onClick: dispatch }, '🚀 发给 zcode'),
          h('button', { className: 'dk-ghost', onClick: () => sendToSession() }, '💬 发到会话'),
          h('span', { className: 'dk-fine' }, '把 TASK.md 的卡派给终端里的 agent（会开新窗口）')),
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
                c.status === 'review'
                  ? (onGoReview !== undefined
                      ? h('button', { className: 'dk-mini', onClick: onGoReview }, '去审阅')
                      : h('button', { className: 'dk-mini', onClick: () => markDone(c.id) }, '审毕标完成'))
                  : null,
                h('button', { className: 'dk-mini', onClick: reload }, '↻'),
              ))
          }),
        ),
      )
    }

    // ── 审阅台（D3下）：review 状态卡 → RESULT.md → 勾选判断 → 落库 LESSONS ──
    function ReviewFlow({ projectId, root, base }) {
      const [cards, setCards] = useState(null)
      const [openId, setOpenId] = useState(null)
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const [picked, setPicked] = useState({})
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)
      const reload = () => API.tasks(projectId).then((j) => {
        const list = j.ok ? j.cards.filter((c) => c.status === 'review') : []
        setCards(list)
        if (openId !== null && !list.some((c) => c.id === openId)) setOpenId(null)
      }).catch(() => setCards([]))
      useEffect(() => {
        reload()
        const t = setInterval(reload, 5000)
        return () => { clearInterval(t) }
      }, [projectId])
      useEffect(() => {
        if (openId === null) { setData(null); setErr(null); setPicked({}); return }
        let alive = true
        setData(null); setErr(null); setPicked({})
        API.reviewResult(projectId, openId).then((j) => {
          if (!alive) return
          if (j.ok) { setData({ result: j.result, widget: j.widget }) } else { setErr(j.error) }
        }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [projectId, openId])
      const toggle = (i) => setPicked((p) => { const n = Object.assign({}, p); if (n[i]) { delete n[i] } else { n[i] = true } return n })
      const approve = () => {
        const picks = Object.keys(picked).map(Number).sort((a, b) => a - b)
        if (picks.length === 0) return
        setBusy(true)
        API.approve(projectId, openId, picks).then((j) => {
          setBusy(false)
          setMsg(j.ok ? `已落库 ${j.count} 条 → ${j.section}（${j.git}）` : '失败：' + j.error)
          if (j.ok) { setOpenId(null); reload() }
        }).catch((e) => { setBusy(false); setMsg(String(e)) })
      }
      if (openId !== null) {
        const r = data !== null ? data.result : null
        return h('div', { className: 'dk-col' },
          h('div', { className: 'dk-toolbar' },
            h('button', { className: 'dk-back', onClick: () => setOpenId(null) }, '‹ 返回审阅列表'),
            msg !== null ? h('span', { className: 'dk-fine' }, msg) : null),
          err !== null ? h(Err, null, err) : null,
          r === null && err === null ? h(Note, null, '读取 RESULT.md…') : null,
          r !== null ? h('div', { className: 'dk-reviewbox' },
            h('div', { className: 'dk-card-title' }, r.summary || '（无摘要）'),
            h('div', { className: 'dk-card-sub' }, `task ${r.task || openId}${r.type !== '' ? ' · ' + r.type : ''}`),
            (r.judgments ?? []).length > 0
              ? h('div', { className: 'dk-field-label' }, '判断（勾选要落库的条目）')
              : h(Note, null, 'RESULT.md 没有「## 判断」小节——无法结构化勾选，可让 zcode 按协议重写'),
            h('div', null, (r.judgments ?? []).map((j, i) =>
              h('label', { key: i, className: 'dk-check' + (picked[i] ? ' on' : '') },
                h('input', { type: 'checkbox', checked: !!picked[i], onChange: () => toggle(i) }),
                h('span', null, j)))),
            (r.sources ?? []).length > 0
              ? h('div', null, h('div', { className: 'dk-field-label' }, '来源'),
                h('ul', { className: 'dk-task-acc' }, r.sources.map((s, i) => h('li', { key: i }, s))))
              : null,
            data.widget !== null && data.widget !== undefined
              ? h('div', null, h('div', { className: 'dk-field-label' }, '产物（widget-result.json）'),
                h(WidgetViews, { widget: data.widget, root, base }))
              : null,
            h('details', { className: 'dk-details' }, h('summary', null, 'RESULT.md 全文'),
              h('div', { className: 'dk-md', dangerouslySetInnerHTML: { __html: mdToHtml(r.body) } })),
            h('div', { className: 'dk-card-actions' },
              h('button', { className: 'dk-mini', disabled: busy || Object.keys(picked).length === 0, onClick: approve },
                `落库选中（${Object.keys(picked).length}）`),
              h('span', { className: 'dk-fine' }, '落库=追加 LESSONS.md 新章节 + git 提交 + 任务卡置 done')),
          ) : null,
        )
      }
      return h('div', { className: 'dk-col' },
        msg !== null ? h(Note, null, msg) : null,
        cards === null ? h(Note, null, '加载中…') : null,
        cards !== null && cards.length === 0 ? h(Note, null, '没有待审阅的任务（zcode 交活后卡会变为“待审阅”）') : null,
        h('div', { className: 'dk-grid' },
          (cards ?? []).map((c) =>
            h('div', { key: c.id, className: 'dk-card task rev', role: 'button', tabIndex: 0, onClick: () => setOpenId(c.id) },
              h('div', { className: 'dk-card-title' }, c.title),
              h('div', { className: 'dk-card-sub' }, c.id + ' · ' + (TYPE_LABEL[c.type] ?? c.type)),
              h('span', { className: 'dk-badge rev' }, '👀 待审阅')))),
        )
    }

    function WidgetViews({ widget, root, base }) {
      return h('div', { className: 'dk-widgets' },
        widget.windows.map((w, i) => {
          if (w.kind === 'html') return h('div', { key: i, className: 'dk-widget' }, h('iframe', { sandbox: '', srcDoc: w.html, className: 'dk-frame' }))
          if (w.kind === 'url') return h('div', { key: i, className: 'dk-widget' }, h('iframe', { sandbox: '', src: w.url, className: 'dk-frame' }))
          return h(FileWidget, { key: i, path: w.path, root, base })
        }),
      )
    }

    function FileWidget({ path, root, base }) {
      const [html, setHtml] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        const rel = String(path ?? '').replace(/^\.\//, '').replace(/^\/+/, '')
        const full = base !== undefined && base !== '' ? base + '/' + rel : rel
        API.read(root, full).then((j) => {
          if (!alive) return
          if (j.ok) { setHtml(j.content) } else { setErr(j.error) }
        }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [path])
      return h('div', { className: 'dk-widget' },
        err !== null ? h(Note, null, '📄 ' + path + '（读取失败：' + err + '）')
        : html === null ? h(Note, null, '📄 ' + path)
        : h('iframe', { sandbox: '', srcDoc: html, className: 'dk-frame' }))
    }

    const KB_TABS = [['quick', 'hub', '速览'], ['search', 'search', '搜索'], ['browse', 'library', '文库'], ['ideas', 'ideas', '点子'], ['tasks', 'tasks', '任务'], ['review', 'review', '审阅'], ['lessons', 'lessons', '复盘'], ['graph', 'graph', '图谱']]

    function KbQuick({ onOpenFile }) {
      const [qv, setQv] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        API.quickview().then((j) => { if (!alive) return; if (j.ok) setQv(j.qv); else setErr(j.error) }).catch((e) => { if (alive) setErr(String(e)) })
        return () => { alive = false }
      }, [])
      if (err !== null) return h(Err, null, err)
      if (qv === null) return h(Note, null, '聚合知识库…')
      const S = qv.stats
      const stat = (k, v, sub) => h('div', { className: 'dk-card', style: { cursor: 'default', minWidth: 150 } },
        h('div', { className: 'dk-fine' }, k), h('div', { style: { fontSize: 26, fontWeight: 750 } }, v), sub !== undefined ? h('div', { className: 'dk-fine' }, sub) : null)
      return h('div', { className: 'dk-col' },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 } },
          stat('Skills', S.skills), stat('精选', S.collections), stat('↑ 今日新增', S.todayNew, '篇'),
          stat('○ 待处理', S.raw), stat('待复核', S.lessonsWarn, '待验证'), stat('→ 关注', S.watchChannels)),
        h('div', { className: 'dk-field-label' }, '收藏 Top（互动量降序，点卡预览）'),
        h('div', { className: 'dk-grid' }, qv.hot.slice(0, 8).map((x, i) =>
          h('div', { key: x.file, className: 'dk-card', onClick: () => onOpenFile(x.file) },
            h('div', { className: 'dk-card-title' }, (i + 1) + '. ' + x.title),
            h('div', { className: 'dk-card-sub' }, (x.heat > 0 ? '热度 ' + x.heat + ' · ' : '') + x.file)))),
        h('div', { className: 'dk-field-label' }, 'Skills（点开方法论）'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, qv.skills.map((sk) =>
          h('button', { key: sk.file, className: 'dk-chip', title: sk.desc, onClick: () => onOpenFile(sk.file) }, sk.name))),
        qv.watch.length > 0 ? h('div', { className: 'dk-field-label' }, '关注（分渠道）') : null,
        qv.watch.length > 0 ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 10 } },
          qv.watch.map((w) => h('div', { key: w.channel, className: 'dk-card', style: { cursor: 'default' } },
            h('div', { className: 'dk-card-title' }, w.channel + ' · ' + w.entries.length),
            w.entries.slice(0, 6).map((e, i) => h('div', { key: i, style: { fontSize: 12.5, opacity: .8, padding: '3px 0' } },
              h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer', style: { color: 'var(--dk-accent)' } }, e.who),
              e.grp ? h('span', { className: 'dk-chip', style: { fontSize: 10.5, padding: '0 8px', marginLeft: 6 } }, e.grp) : null,
              e.why !== '' ? h('span', { style: { opacity: .6 } }, ' — ' + e.why) : null))))) : null,
        qv.lessonsWarnList.length > 0 ? h('div', { className: 'dk-field-label' }, '判断回看（' + qv.lessonsWarnList.length + ' 条待验证）') : null,
        qv.lessonsWarnList.length > 0 ? h('div', { className: 'dk-card', style: { cursor: 'default', display: 'flex', flexDirection: 'column', gap: 4 } },
          qv.lessonsWarnList.slice().reverse().map((l, i) => h('div', { key: i, style: { fontSize: 12.5, opacity: .8, borderBottom: '1px dashed var(--color-border-1,#2a2e37)', padding: '4px 0' } }, l))) : null,
      )
    }
    function KnowledgeDesk() {
      const [tab, setTab] = useState(() => { const t = kbPendingTab; kbPendingTab = null; return t || 'quick' })
      const [quickFile, setQuickFile] = useState(null)
      // kbGoTab 保持 pending 版（总台未挂载知识库台时也能定向）
      if (quickFile !== null) {
        return h('div', { className: 'dk-desk' },
          h('div', { className: 'dk-deskbar' }, h('button', { className: 'on' }, '📄 ' + quickFile.split('/').pop())),
          h('div', { className: 'dk-deskmain' }, h(Preview, { root: 'kb', path: quickFile, onBack: () => setQuickFile(null) })))
      }
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' }, KB_TABS.map(([id, label]) =>
          h('button', { key: id, className: tab === id ? 'on' : '', onClick: () => setTab(id) }, h(Icon, { name: label, size: 14, style: { marginRight: 5, verticalAlign: -2 } }), label === 'search' ? '搜索' : label === 'library' ? '文库' : label === 'ideas' ? '点子' : label === 'tasks' ? '任务' : label === 'review' ? '审阅' : label === 'lessons' ? '复盘' : label === 'graph' ? '图谱' : label))),
        h('div', { className: 'dk-deskmain' },
          tab === 'quick' ? h(KbQuick, { onOpenFile: (f) => setQuickFile(f) })
          : tab === 'search' ? h(KbSearch)
          : tab === 'browse' ? h(FsBrowse, { root: 'kb', base: '', layers: LAYERS })
          : tab === 'ideas' ? h(KbIdeas)
          : tab === 'tasks' ? h(TaskBoard, { projectId: 'builtin-kb', onGoReview: () => setTab('review') })
          : tab === 'review' ? h(ReviewFlow, { projectId: 'builtin-kb', root: 'kb' })
          : tab === 'graph' ? h(KbGraph)
          : h(KbReview)),
      )
    }

    // ── 自媒体台（D4）：内容项看板四列 + 选题创建 + 详情（文件/产物/交 zcode）──
    const CONTENT_COLS = [
      ['idea', '选题', ['idea']],
      ['drafting', '创作', ['drafting']],
      ['ready', '待发', ['ready', 'prefill']],
      ['published', '已发布', ['published']],
    ]
    const CTYPE = { article: ['📝', '文章'], video: ['🎬', '视频'], ppt: ['📊', 'PPT'] }
    const NEXT_STATUS = { idea: 'drafting', drafting: 'ready', ready: 'prefill', prefill: 'published', published: null }

    function MediaDesk() {
      const [tab, setTab] = useState('board')
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' },
          [['board', 'grid', '看板'], ['new', 'plus', '选题'], ['files', 'folder', '文件'], ['tasks', 'tasks', '任务']].map(([id, icon, text]) =>
            h('button', { key: id, className: tab === id ? 'on' : '', onClick: () => setTab(id) }, h(Icon, { name: icon, size: 14, style: { marginRight: 5, verticalAlign: -2 } }), text))),
        h('div', { className: 'dk-deskmain' },
          tab === 'board' ? h(MediaBoard)
          : tab === 'new' ? h(NewTopic, { onDone: () => setTab('board') })
          : tab === 'files' ? h(FsBrowse, { root: 'content', base: '', layers: null })
          : h(TaskBoard, { projectId: 'builtin-media' })),
      )
    }

    function MediaBoard() {
      const [items, setItems] = useState(null)
      const [openSlug, setOpenSlug] = useState(null)
      const [err, setErr] = useState(null)
      const reload = () => API.contentList().then((j) => {
        if (j.ok) { setItems(j.items); setErr(null) } else { setErr(j.error) }
      }).catch((e) => setErr(String(e)))
      useEffect(() => {
        reload()
        const t = setInterval(reload, 5000)
        return () => { clearInterval(t) }
      }, [])
      const open = items !== null ? (items.find((i) => i.slug === openSlug) ?? null) : null
      return h('div', { className: 'dk-col' },
        err !== null ? h(Err, null, err) : null,
        items === null && err === null ? h(Note, null, '加载内容项…') : null,
        items !== null && items.length === 0 ? h(Note, null, 'content/ 还没有内容项——去「选题」建一个，或从知识台点子「→ 选题夹」') : null,
        h('div', { className: 'dk-board media' },
          CONTENT_COLS.map(([id, label, sts]) =>
            h('div', { key: id, className: 'dk-board-col' },
              h('div', { className: 'dk-board-colhead' }, label),
              (items ?? []).filter((i) => sts.includes(i.status)).map((i) =>
                h('button', { key: i.slug, className: 'dk-chip-task', onClick: () => setOpenSlug(i.slug) },
                  h('span', { className: 'dk-chip-task-t' }, (CTYPE[i.type] ?? ['📄'])[0] + ' ' + i.title),
                  h('span', { className: 'dk-chip-task-p' }, i.created + (i.platforms !== '' ? ' · ' + i.platforms : '')))))),
        ),
        open !== null ? h(ContentDetail, { item: open, onClose: () => setOpenSlug(null), onChanged: reload }) : null,
      )
    }


    // ── 产出预览：PPT 放映（键盘←→翻页/Esc 退出/O 概览）+ 文章阅读 ──
    function PPTViewer({ html, title, onClose, onEditSlide }) {
      const [cur, setCur] = useState(0)
      const [ov, setOv] = useState(false)
      const slides = html.match(/<section[^>]*>[\s\S]*?<\/section>/g) || [html]
      const n = slides.length
      useEffect(() => {
        const fn = (e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); setCur(c => (c + 1) % n) }
          if (e.key === 'ArrowLeft') { e.preventDefault(); setCur(c => (c - 1 + n) % n) }
          if (e.key === 'Escape') { if (ov) setOv(false); else onClose() }
          if (e.key === 'o') setOv(v => !v)
        }
        document.addEventListener('keydown', fn)
        return () => { document.removeEventListener('keydown', fn) }
      }, [n, ov])
      const ci = Math.min(cur, n - 1)
      const nav = h('div', { style: { height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexShrink: 0 } },
        h('button', { className: 'dk-mini', onClick: () => setCur((ci - 1 + n) % n) }, '‹'),
        ...Array.from({ length: Math.min(n, 12) }, (_, i) =>
          h('button', { key: i, onClick: () => setCur(i), style: { width: i === ci ? 22 : 8, height: 8, borderRadius: 4, border: 'none', cursor: 'pointer', background: i === ci ? '#5b6cff' : '#333', transition: '.15s' } })),
        h('button', { className: 'dk-mini', onClick: () => setCur((ci + 1) % n) }, '›'))
      const stage = ov
        ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 10, width: '100%', padding: '0 20px', overflowY: 'auto' } },
            slides.map((sl, i) =>
              h('iframe', { key: i, sandbox: '', srcDoc: sl, onClick: () => { setCur(i); setOv(false) },
                style: { aspectRatio: '16/9', width: '100%', border: i === ci ? '2px solid #5b6cff' : '1px solid #333', borderRadius: 8, cursor: 'pointer', background: '#0e1015' } })))
        : h('iframe', { sandbox: '', srcDoc: slides[ci],
            style: { aspectRatio: '16/9', maxHeight: '100%', maxWidth: 'min(90vw,1100px)', width: '100%', border: '1px solid #2a2e37', borderRadius: 12, background: '#0e1015', boxShadow: '0 20px 80px rgba(0,0,0,.5)' } })
      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 100, background: '#08090d', display: 'flex', flexDirection: 'column' } },
        h('div', { style: { height: 44, display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', borderBottom: '1px solid #222', flexShrink: 0 } },
          h('b', { style: { fontSize: 14 } }, title),
          h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 12, opacity: .6 } }, 'P' + (ci + 1) + ' / ' + n),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'dk-mini', onClick: () => setOv(v => !v) }, ov ? '□ 退出概览' : '⊞ 概览'),
          onEditSlide ? h('button', { className: 'dk-mini', onClick: () => onEditSlide(ci) }, '改这页') : null,
          h('button', { className: 'dk-mini', onClick: onClose }, '退出放映')),
        h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, padding: '12px 0' } }, stage),
        ov ? null : nav,
      )
    }
    function ArticleReader({ md, title, onClose }) {
      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 100, background: 'var(--color-bg-0,#0b0d12)', display: 'flex', flexDirection: 'column' } },
        h('div', { style: { height: 46, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px', borderBottom: '1px solid var(--color-border-1,#2a2e37)', flexShrink: 0 } },
          h('b', { style: { fontSize: 14 } }, title),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'dk-mini', onClick: onClose }, '退出阅读')),
        h('div', { style: { flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center' } },
          h('div', { className: 'dk-md', style: { width: 'min(780px,92%)', padding: '28px 36px 60px', fontSize: 16, lineHeight: 2 }, dangerouslySetInnerHTML: { __html: mdToHtml(md) } })),
      )
    }

    function ContentDetail({ item, onClose, onChanged }) {
      const [topicHtml, setTopicHtml] = useState(null)
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)
      const [widget, setWidget] = useState(null)
      const [pub, setPub] = useState(null)
      const [pptHtml, setPptHtml] = useState(null)
      const [artMd, setArtMd] = useState(null)
      useEffect(() => {
        let alive = true
        API.read('content', item.slug + '/选题.md').then((j) => { if (alive) { setTopicHtml(j.ok ? mdToHtml(j.content) : '<p>（无选题.md）</p>') } }).catch(() => {})
        API.read('content', item.slug + '/widget-result.json').then((j) => {
          if (!alive) return
          try { setWidget(j.ok ? JSON.parse(j.content) : null) } catch { setWidget(null) }
        }).catch(() => {})
        return () => { alive = false }
      }, [item.slug])
      if (pptHtml !== null) return h(PPTViewer, { html: pptHtml, title: item.title, onClose: () => { setPptHtml(null); onClose() } })
      if (artMd !== null) return h(ArticleReader, { md: artMd, title: item.title, onClose: () => { setArtMd(null); onClose() } })
      const advance = () => {
        const next = NEXT_STATUS[item.status]
        if (next === null) return
        API.contentStatus(item.slug, next).then((j) => { if (j.ok) { onChanged(); setMsg('状态 → ' + next) } else { setMsg('失败：' + j.error) } })
      }
      const handoff = () => {
        setBusy(true)
        API.contentHandoff(item.slug).then((j) => {
          setBusy(false)
          if (!j.ok) { setMsg('失败：' + j.error); return }
          window.__deckLastCmd = j.command
          setMsg(j.mode === 'terminal' ? '已建任务卡 ' + j.card.id + ' 并开终端跑 zcode ✓' : '已建任务卡，终端拉起失败——复制命令手动跑')
        }).catch((e) => { setBusy(false); setMsg(String(e)) })
      }
      const htmlFiles = item.files.filter((f) => f.endsWith('.html'))
      const next = NEXT_STATUS[item.status]
      return h('div', { className: 'dk-modal-back', onClick: (e) => { if (e.target.className === 'dk-modal-back') onClose() } },
        h('div', { className: 'dk-modal wide' },
          h('div', { className: 'dk-modal-title' }, (CTYPE[item.type] ?? ['📄'])[0] + ' ' + item.title),
          h('div', { className: 'dk-card-sub' }, 'content/' + item.slug + '/ · ' + item.status + (item.platforms !== '' ? ' · ' + item.platforms : '')),
          msg !== null ? h(Note, null, msg, window.__deckLastCmd !== undefined && msg !== null && msg.includes('复制')
            ? h('button', { className: 'dk-mini', style: { marginLeft: 8 }, onClick: async () => { try { await navigator.clipboard.writeText(window.__deckLastCmd); setMsg('命令已复制 ✓') } catch {} } }, '复制命令') : null) : null,
          topicHtml !== null ? h('div', { className: 'dk-md', style: { maxHeight: 200, overflowY: 'auto', border: '1px solid var(--color-border-1,#2a2e37)', borderRadius: 10, padding: '8px 12px' }, dangerouslySetInnerHTML: { __html: topicHtml } }) : null,
          h('div', { className: 'dk-field-label' }, '文件'),
          h('div', { className: 'dk-filechips' },
            item.files.map((f) => h('button', {
              key: f, className: 'dk-chip', title: f,
              onClick: () => { API.read('content', item.slug + '/' + f).then((j) => { if (j.ok) setTopicHtml(mdToHtml(f.endsWith('.json') ? '```json\n' + j.content + '\n```' : j.content)) }) },
            }, f))),
          widget !== null && widget.windows
            ? h('div', null, h('div', { className: 'dk-field-label' }, '产物（widget-result.json）'),
              h(WidgetViews, { widget, root: 'content', base: item.slug }))
            : null,
          htmlFiles.length > 0
            ? h('div', null, h('div', { className: 'dk-field-label' }, 'HTML 产物'),
              htmlFiles.filter((f) => {
                const n = './' + f
                return !(widget !== null && widget.windows && widget.windows.some((w) => w.path === f || w.path === n || (w.path ?? '').replace(/^\.\//, '') === f))
              }).map((f) => h(FileWidget, { key: f, path: f, root: 'content', base: item.slug })))
            : null,
          h('div', { className: 'dk-modal-actions' },
            h('button', { type: 'button', className: 'dk-ghost', onClick: onClose }, '关闭'),
            next !== null ? h('button', { type: 'button', className: 'dk-ghost', onClick: advance }, '状态 → ' + next) : null,
            item.files.filter(f => f.endsWith('.html')).length > 0
              ? h('button', { type: 'button', className: 'dk-ghost', onClick: () => {
                  const f = item.files.find(x => x.endsWith('.html'))
                  API.read('content', item.slug + '/' + f).then(j => { if (j.ok) setPptHtml(j.content) })
                } }, '▶ 放映') : null,
            item.files.filter(f => f.endsWith('.md') && !f.includes('meta') && !f.includes('发布记录')).length > 0
              ? h('button', { type: 'button', className: 'dk-ghost', onClick: () => {
                  const f = item.files.find(x => x.endsWith('.md') && !x.includes('meta') && !x.includes('发布记录'))
                  API.read('content', item.slug + '/' + f).then(j => { if (j.ok) setArtMd(j.content) })
                } }, '阅读') : null,
            h('button', { type: 'button', className: 'dk-ghost', onClick: () => setPub(item.status) }, '预填发布'),
            h('button', { type: 'button', disabled: busy, onClick: handoff }, '🚀 交给 zcode')),
        ),
        pub !== null ? h(PublishFlow, { item, stage: pub, onClose: () => setPub(null), onChanged }) : null,
      )
    }

    // ── D5 发布预填：意图链打开（微博 share / X intent）+ 剪贴板兜底；人工点发后回写记录 ──
    function PublishFlow({ item, stage, onClose, onChanged }) {
      const [platform, setPlatform] = useState('weibo')
      const [msg, setMsg] = useState(null)
      const [url, setUrl] = useState(null)
      const [text, setText] = useState('')
      const [link, setLink] = useState('')
      const doPrefill = () => {
        setMsg('生成预填…')
        API.prefill(item.slug, platform).then((j) => {
          if (!j.ok) { setMsg('失败：' + j.error); return }
          setUrl(j.url); setText(j.text)
          try { window.open(j.url, '_blank', 'noopener') } catch {}
          setMsg(j.platform + ' 预填页已打开（被拦就点下面链接）——确认内容后**你自己点发布**')
          onChanged()
        }).catch((e) => setMsg(String(e)))
      }
      const copy = async () => { try { await navigator.clipboard.writeText(text); setMsg('预填文本已复制 ✓') } catch { setMsg('复制失败，手动选择') } }
      const record = () => {
        API.publishRecord(item.slug, platform, link).then((j) => {
          if (!j.ok) { setMsg('失败：' + j.error); return }
          setMsg('已记录发布 + 状态 → published ✓')
          onChanged()
          setTimeout(onClose, 800)
        })
      }
      return h('div', { className: 'dk-modal-back', onClick: (e) => { if (e.target.className === 'dk-modal-back') onClose() } },
        h('div', { className: 'dk-modal' },
          h('div', { className: 'dk-modal-title' }, '预填发布 · ' + item.title),
          h('div', { className: 'dk-field-row' },
            h('div', { className: 'dk-field' }, h('label', null, '平台'),
              h('select', { value: platform, onChange: (e) => setPlatform(e.target.value) },
                h('option', { value: 'weibo' }, '微博'),
                h('option', { value: 'x' }, 'X')))),
          msg !== null ? h(Note, null, msg) : null,
          url !== null ? h('div', { className: 'dk-col', style: { gap: 6 } },
            h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, '↗ 打开预填页'),
            h('textarea', { value: text, readOnly: true, rows: 4, style: { background: 'var(--color-bg-2,#1b1e26)', color: 'inherit', border: '1px solid var(--color-border-1,#2a2e37)', borderRadius: 8, padding: 8, font: '12px/1.6 ui-monospace,monospace' } }),
            h('button', { type: 'button', className: 'dk-mini', style: { alignSelf: 'flex-start' }, onClick: copy }, '复制预填文本')) : null,
          stage === 'published'
            ? null
            : h('div', { className: 'dk-field' }, h('label', null, '发布完成后：贴链接回写记录'),
              h('div', { className: 'dk-field-row' },
                h('input', { value: link, onChange: (e) => setLink(e.target.value), placeholder: 'https://（可空）', style: { flex: 1 } }),
                h('button', { type: 'button', onClick: record }, '已发布，记录 ✓'))),
          h('div', { className: 'dk-modal-actions' },
            h('button', { type: 'button', className: 'dk-ghost', onClick: onClose }, '关闭'),
            h('button', { type: 'button', onClick: doPrefill }, '生成预填并打开')),
        ),
      )
    }

    function NewTopic({ onDone }) {
      const [title, setTitle] = useState('')
      const [type, setType] = useState('article')
      const [platforms, setPlatforms] = useState('')
      const [msg, setMsg] = useState(null)
      const submit = (e) => {
        e.preventDefault()
        if (title.trim() === '') { setMsg('标题必填'); return }
        API.contentCreate(title, type, platforms).then((j) => {
          if (!j.ok) { setMsg('失败：' + j.error); return }
          setMsg('已建 ✓ content/' + j.item.slug + '/（含' + (CTYPE[type][1]) + '模板）')
          setTitle(''); setPlatforms('')
          setTimeout(onDone, 600)
        })
      }
      return h('form', { className: 'dk-taskform', onSubmit: submit, style: { maxWidth: 560 } },
        h('input', { value: title, onChange: (e) => setTitle(e.target.value), placeholder: '选题标题（将建 content/{slug}/ 一整套文件夹）', autoFocus: true }),
        h('div', { className: 'dk-taskform-row' },
          h('select', { value: type, onChange: (e) => setType(e.target.value) },
            Object.keys(CTYPE).map((t) => h('option', { key: t, value: t }, CTYPE[t][0] + ' ' + CTYPE[t][1]))),
          h('input', { value: platforms, onChange: (e) => setPlatforms(e.target.value), placeholder: '目标平台（可空，如 公众号/微博/X）', style: { flex: 1 } })),
        h('div', { className: 'dk-taskform-row' },
          h('button', { type: 'submit' }, '建选题'),
          msg !== null ? h('span', { className: 'dk-fine', style: { alignSelf: 'center' } }, msg) : null),
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
    async function promptIntoSession(sessionId, text) {
  const b = deckCtx
  if (!b) throw new Error('bridge unavailable')
  const sessions = b.sessions
  let session = null
  for (let i = 0; i < 10; i++) {
    try { session = sessions && sessions.binding ? sessions.binding(sessionId)?.session ?? null : null } catch { session = null }
    if (session) break
    await new Promise((r) => setTimeout(r, 200))
  }
  if (session) {
    if (b.conversation && typeof b.conversation.sendSession === 'function') { try { await b.conversation.sendSession(session, text, [], 'queue'); return } catch {} }
    if (typeof session.prompt === 'function') { const r = await session.prompt([{ type: 'text', text }], 'queue'); if (r && r.ok) return }
  }
  try { const scoped = sessions && sessions.scope ? sessions.scope(sessionId) : null; const conv = scoped ? scoped.get('conversation') : null; if (conv && typeof conv.send === 'function') { await conv.send(text); return } } catch {}
  throw new Error('no send path')
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
      const [editing, setEditing] = useState(null)
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
          h('button', { className: tab === 'projects' ? 'on' : '', onClick: () => setTab('projects') }, '项目'),
          h('button', { className: tab === 'board' ? 'on' : '', onClick: () => setTab('board') }, '统一看板'),
          h('button', { className: tab === 'sessions' ? 'on' : '', onClick: () => setTab('sessions') }, '会话镜像')),
        h('div', { className: 'dk-deskmain' },
          msg !== null ? h(Note, null, msg) : null,
          tab === 'projects'
            ? h('div', { className: 'dk-grid wide' },
                projects.map((p) => {
                  const bound = p.bindSession !== undefined && sessionsStore.byId[p.bindSession] !== undefined ? sessionsStore.byId[p.bindSession] : null
                  return h('div', { key: p.id, className: 'dk-card room' + (p.hidden ? ' hidden' : '') },
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
                          (bound !== null && bound.running ? '🏃 ' : '') + sessTitle(bound !== null ? bound : { id: p.bindSession }))
                      : h('button', { className: 'dk-bind', onClick: () => setPicking(picking === p.id ? null : p.id) }, '绑定会话'),
                    picking === p.id ? h(SessionPicker, {
                      project: p,
                      onDone: (e) => { setPicking(null); if (typeof e === 'string') setMsg(e) },
                    }) : null,
                    h('div', { className: 'dk-card-actions' },
                      h('button', { className: 'dk-mini', onClick: () => { goProject(p.id) } }, '打开 →'),
                      h('button', { className: 'dk-mini', onClick: () => setEditing(p) }, '编辑'),
                      p.id.startsWith('builtin-')
                        ? h('button', { className: 'dk-mini', onClick: () => { API.projectUpdate(p.id, { hidden: !p.hidden }); setTimeout(loadState, 300) } }, p.hidden ? '取消隐藏' : '隐藏')
                        : h('button', { className: 'dk-mini danger', onClick: () => { if (window.confirm('删除工作台「' + p.name + '」？（只解除注册，不动磁盘文件）')) post('/api/deck/project/delete', { id: p.id }).then(() => { loadState() }) } }, '删除')),
                  )
                }),
                h('div', { className: 'dk-card room add', role: 'button', tabIndex: 0, onClick: () => setWizard(true) },
                  h('div', { className: 'dk-room-icon' }, '＋'),
                  h('div', { className: 'dk-card-title' }, '新建工作台'),
                  h('div', { className: 'dk-card-sub' }, '名称/图标/文件夹/模板')))
          : tab === 'board'
            ? h(BoardView, { boards: boards ?? [] })
          : h(SessionMirror),
          wizard ? h(NewProjectWizard, {
            onClose: () => setWizard(false),
            onCreated: (p) => { setWizard(false); setMsg('已创建 ✓ ' + p.name + '（脚手架已写入）'); goProject(p.id) },
          }) : null,
          editing !== null ? h(EditProject, {
            project: editing,
            onClose: () => setEditing(null),
            onSaved: () => { setEditing(null); setMsg('已保存 ✓'); loadState() },
          }) : null,
        ),
      )
    }

    // 会话实时镜像（worktable 精华）：宿主快照订阅驱动，零轮询零 token
    function SessionMirror() {
      const rows = sessionsStore.ids.map((id) => sessionsStore.byId[id]).filter(Boolean)
      const running = rows.filter((s) => s.running === true)
      const pending = rows.filter((s) => s.running !== true && s.pendingInteraction)
      const rest = rows.filter((s) => s.running !== true && !s.pendingInteraction).slice(0, 12)
      const col = (list) => list.map((s) =>
        h('button', { key: s.id, className: 'dk-sesscard' + (s.id === sessionsStore.current ? ' cur' : ''), onClick: () => openSession(s.id), title: s.cwd || '' },
          h('span', { className: 'dk-sessrow-t' }, sessTitle(s)),
          h('span', { className: 'dk-sessrow-c' }, (s.cwd || '').split(/[\\/]/).pop() || '')))
      return h('div', { className: 'dk-col' },
        h(Note, null, '宿主会话快照订阅镜像（零轮询）· 共 ' + rows.length + ' 条 · 当前：' + (sessionsStore.current ? sessTitle(sessionsStore.byId[sessionsStore.current] || { id: sessionsStore.current }) : '无')),
        h('div', { className: 'dk-board' },
          h('div', { className: 'dk-board-col' }, h('div', { className: 'dk-board-colhead' }, '🏃 工作中 · ' + running.length), col(running.slice(0, 10))),
          h('div', { className: 'dk-board-col' }, h('div', { className: 'dk-board-colhead' }, '待你决定 · ' + pending.length), col(pending.slice(0, 10))),
          h('div', { className: 'dk-board-col' }, h('div', { className: 'dk-board-colhead' }, '空闲'), col(rest)),
        ),
      )
    }

    function EditProject({ project, onClose, onSaved }) {
      const [name, setName] = useState(project.name)
      const [icon, setIcon] = useState(project.icon || '📁')
      const [order, setOrder] = useState(String(project.order))
      const [msg, setMsg] = useState(null)
      const submit = (e) => {
        e.preventDefault()
        const o = Number(order)
        if (name.trim() === '') { setMsg('名称必填'); return }
        if (!Number.isFinite(o)) { setMsg('排序必须是数字'); return }
        API.projectUpdate(project.id, { name: name.trim(), icon, order: o }).then((j) => {
          if (!j.ok) { setMsg('失败：' + j.error); return }
          onSaved()
        }).catch((e2) => setMsg(String(e2)))
      }
      return h('div', { className: 'dk-modal-back', onClick: (e) => { if (e.target.className === 'dk-modal-back') onClose() } },
        h('form', { className: 'dk-modal', onSubmit: submit },
          h('div', { className: 'dk-modal-title' }, '编辑工作台'),
          h('div', { className: 'dk-field-row' },
            h('div', { className: 'dk-field' }, h('label', null, '图标'), h('input', { value: icon, onChange: (e) => setIcon(e.target.value), size: 4 })),
            h('div', { className: 'dk-field' }, h('label', null, '排序（小→前）'), h('input', { value: order, onChange: (e) => setOrder(e.target.value), size: 6 }))),
          h('div', { className: 'dk-field' }, h('label', null, '名称'), h('input', { value: name, onChange: (e) => setName(e.target.value), autoFocus: true })),
          msg !== null ? h(Err, null, msg) : null,
          h('div', { className: 'dk-modal-actions' },
            h('button', { type: 'button', className: 'dk-ghost', onClick: onClose }, '取消'),
            h('button', { type: 'submit' }, '保存')),
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

    // ── 通用项目台面（自定义工作台：任务 + 审阅 + 文件）──
    function GenericDesk({ project }) {
      const [tab, setTab] = useState('tasks')
      const loc = resolveAlias(project.folder)
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' },
          h('button', { className: tab === 'tasks' ? 'on' : '', onClick: () => setTab('tasks') }, '任务'),
          h('button', { className: tab === 'review' ? 'on' : '', onClick: () => setTab('review') }, '审阅'),
          h('button', { className: tab === 'files' ? 'on' : '', onClick: () => setTab('files') }, '文件'),
          loc === null ? h('span', { className: 'dk-fine', style: { alignSelf: 'center', marginLeft: 6 } }, '⚠ 文件夹不在注册根内，文件/审阅产物不可用') : null),
        h('div', { className: 'dk-deskmain' },
          tab === 'tasks'
            ? h(TaskBoard, { projectId: project.id, onGoReview: () => setTab('review') })
          : tab === 'review'
            ? (loc !== null ? h(ReviewFlow, { projectId: project.id, root: loc.root, base: loc.rel }) : h(Note, null, '此项目文件夹不在注册根内，无法审阅'))
            : loc !== null ? h(FsBrowse, { root: loc.root, base: loc.rel, layers: null })
              : h(Note, null, '此项目文件夹不在 kb/content 根内，无法浏览')),
      )
    }

    // ── v4 总台：待办/进行中/灵感流 聚合 ──
    function HubDesk() {
      const [boards, setBoards] = useState(null)
      const [items, setItems] = useState(null)
      const [ideas, setIdeas] = useState(null)
      const [msg, setMsg] = useState(null)
      const reload = () => {
        API.boards().then((j) => { if (j && j.ok) setBoards(j.boards) }).catch(() => {})
        API.contentList().then((j) => { if (j && j.ok) setItems(j.items) }).catch(() => {})
        API.ideas().then((j) => { if (j && j.ok) setIdeas(j.ideas) }).catch(() => {})
      }
      useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => { clearInterval(t) } }, [])
      const reviewCards = (boards ?? []).flatMap((b) => b.cards.filter((c) => c.status === 'review').map((c) => ({ b, c })))
      const readyItems = (items ?? []).filter((i) => i.status === 'ready' || i.status === 'prefill')
      const running = (boards ?? []).flatMap((b) => b.cards.filter((c) => c.status === 'running').map((c) => ({ b, c })))
      const drafting = (items ?? []).filter((i) => i.status === 'idea' || i.status === 'drafting')
      const seedIdeas = (ideas ?? []).filter((i) => i.status !== 'picked')
      const goReview = () => { goDesk('kb'); if (kbGoTab) kbGoTab('review') }
      const goItem = (slug) => { goDesk('content'); if (mediaGoItem) mediaGoItem(slug) }
      const inner = h('div', { className: 'dk-col' },
        msg !== null ? h(Note, null, msg) : null,
        reviewCards.length + readyItems.length === 0
          ? h(Note, null, '没有待你决定的——agent 交活/内容待发会出现在这')
          : h('div', { className: 'dk-col', style: { gap: 8 } },
              reviewCards.map(({ b, c }) =>
                h('div', { key: 'r' + b.id + c.id, className: 'dk-card dk-todo urgent', onClick: goReview },
                  h(Icon, { name: 'review', size: 26, style: { color: 'var(--dk-accent)' } }), h('span', { className: 'nm' }, '审阅落库'),
                  h('span', { className: 'pv' }, c.title + '（' + b.name + '）→ LESSONS'),
                  h('button', { className: 'dk-mini', onClick: (e) => { e.stopPropagation(); goReview() } }, '去审阅'))),
              readyItems.map((i) =>
                h('div', { key: i.slug, className: 'dk-card dk-todo urgent', onClick: () => goItem(i.slug) },
                  h(Icon, { name: 'publish', size: 26, style: { color: 'var(--dk-accent)' } }), h('span', { className: 'nm' }, '发布终审'),
                  h('span', { className: 'pv' }, i.title + ' · 预填就绪'),
                  h('button', { className: 'dk-mini', onClick: (e) => { e.stopPropagation(); goItem(i.slug) } }, '去点发')))),
        h('div', { className: 'dk-toolbar' }, h('span', { className: 'dk-field-label' }, '进行中的件 · ' + (running.length + drafting.length))),
        running.map(({ b, c }) =>
          h('div', { key: 't' + b.id + c.id, className: 'dk-flowrow' },
            h('span', { className: 'ftt' }, c.title),
            h('div', { className: 'dk-steps' }, FLOW_STEPS.slice(1).map((st, k) => {
              const real = k + 1, step = stepOfTask(c.status)
              return h('span', { key: st },
                h('span', { className: 'dk-step ' + (real < step ? 'done' : real === step ? 'now' : '') }, h('i', null, real < step ? '✓' : real + 1), st),
                real < 4 ? h('span', { className: 'dk-stepline ' + (real < step ? 'done' : '') }) : null)
            })),
            c.status === 'queued' ? h('span', null,
              h('button', { className: 'dk-mini', onClick: () => { window.__dkDispatchProject = b.id; window.__dkNeedLaunch = (window.__dkLaunchSeen !== '1'); notify() } }, null, h(Icon, { name: 'send', size: 12, style: { marginRight: 3 } }), ' 派发'),
              h('button', { className: 'dk-mini', style: { marginLeft: 5 }, onClick: async () => {
                const proj = stateStore.projects.find((p) => p.id === b.id)
                const sid = (proj && proj.bindSession) || sessionsStore.current
                if (!sid) { window.alert('先在控制室绑定会话'); return }
                const text = '【dsh-deck 任务派发】\n任务：' + c.title + '\n读 TASK.md 找 queued 卡→干活→写 RESULT.md→改 review'
                try { await promptIntoSession(sid, text); openSession(sid) } catch (e) { window.alert(String(e.message || e)) }
              } }, null, h(Icon, { name: 'chat', size: 12, style: { marginRight: 3 } }), ' 会话')) : null)),
        drafting.map((i) =>
          h('div', { key: i.slug, className: 'dk-flowrow' },
            h('span', { className: 'ftt' }, i.title),
            h('div', { className: 'dk-steps' }, FLOW_STEPS.map((st, k) => {
              const step = stepOfContent(i.status)
              return h('span', { key: st },
                h('span', { className: 'dk-step ' + (k < step ? 'done' : k === step ? 'now' : '') }, h('i', null, k < step ? '✓' : k + 1), st),
                k < 4 ? h('span', { className: 'dk-stepline ' + (k < step ? 'done' : '') }) : null)
            })),
            stepOfContent(i.status) === 3 ? h('button', { className: 'dk-mini', onClick: () => goItem(i.slug) }, '去发布') : null)),
        h('div', { className: 'dk-toolbar' }, h('span', { className: 'dk-field-label' }, '灵感流 · ' + seedIdeas.length)),
        h('div', { style: { display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 } },
          seedIdeas.map((idea) =>
            h('div', { key: idea.file, className: 'dk-card', style: { minWidth: 250, maxWidth: 250, cursor: 'default', flexShrink: 0 } },
              h('div', { className: 'dk-card-title' }, idea.title),
              h('div', { className: 'dk-card-sub' }, (idea.created || '') + ' · ' + idea.status),
              h('div', { className: 'dk-card-actions' },
                h('button', { className: 'dk-mini', onClick: () => API.adopt(idea.file, 'research').then((j) => { setMsg(j.ok ? '✓ 已升任务 → 调研台' : '失败：' + j.error); reload() }) }, '升任务'),
                h('button', { className: 'dk-mini', onClick: () => { goDesk('kb'); if (kbGoTab) kbGoTab('ideas') } }, '看全部'))))),
      )
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' }, h('button', { className: 'on' }, '今日动线 · 待办 → 进行中 → 灵感')),
        h('div', { className: 'dk-deskmain' }, inner))
    }

    function MsgDesk() {
      const [msgs, setMsgs] = useState(null)
      const [showAdd, setShowAdd] = useState(false)
      const [replying, setReplying] = useState(null)
      const [replyText, setReplyText] = useState('')
      const [msg, setMsg] = useState(null)
      const reload = () => API.msgList().then((j) => setMsgs(j.ok ? j.messages : [])).catch(() => setMsgs([]))
      useEffect(() => { reload() }, [])
      const addMsg = (plat, author, text, slug) => {
        API.msgAdd({ platform: plat, author, text, contentSlug: slug }).then((j) => {
          if (j.ok) { setShowAdd(false); reload() } else setMsg('失败：' + j.error)
        })
      }
      const doDraft = (id) => {
        setReplying(id); setReplyText('起草中…')
        API.msgDraft(id).then((j) => { if (j.ok) { setReplyText(j.draft) } else { setMsg('起草失败') } })
      }
      const doReply = () => {
        API.msgReply(replying, replyText).then((j) => {
          if (j.ok) { setReplying(null); setReplyText(''); reload() } else setMsg('失败：' + j.error)
        })
      }
      const news = (msgs ?? []).filter((m) => m.status === 'new')
      const replied = (msgs ?? []).filter((m) => m.status === 'replied')
      return h('div', { className: 'dk-desk' },
        h('div', { className: 'dk-deskbar' },
          h('button', { className: 'on' }, '消息台 · 新 ' + news.length + ' · 已回 ' + replied.length),
          h('button', { style: { marginLeft: 8, background: 'none', border: '1px solid var(--color-border-1,#2a2e37)', borderRadius: 999, color: 'var(--dk-accent,#5b6cff)', cursor: 'pointer', padding: '4px 14px', fontSize: 13 } , onClick: () => setShowAdd(!showAdd) }, showAdd ? '收起' : '＋ 手动添加')),
        h('div', { className: 'dk-deskmain' },
          h('div', { className: 'dk-col' },
            msg !== null ? h(Note, null, msg) : null,
            showAdd ? h(AddMsgForm, { onAdd: addMsg }) : null,
            msgs === null ? h(Note, null, '加载中…') : null,
            msgs !== null && msgs.length === 0 ? h(Note, null, '没有消息——点「＋ 手动添加」把平台评论粘进来，或让 agent 从通知页导入') : null,
            news.length > 0 ? h('div', { className: 'dk-field-label' }, '新评论（' + news.length + '）') : null,
            news.map((m) => h(MsgCard, { key: m.id, m, onDraft: doDraft, onReply: () => { setReplying(m.id); setReplyText('') }, onDelete: () => API.msgDelete(m.id).then(reload) })),
            replying !== null ? h('div', { className: 'dk-card', style: { cursor: 'default' } },
              h('div', { className: 'dk-field-label' }, '回复'),
              h('textarea', { value: replyText, onChange: (e) => setReplyText(e.target.value), rows: 3, style: { width: '100%', background: 'var(--color-bg-2,#1b1e26)', color: 'inherit', border: '1px solid var(--color-border-1,#2a2e37)', borderRadius: 8, padding: 8, font: '13px/1.6 system-ui', outline: 'none', resize: 'vertical' } }),
              h('div', { className: 'dk-card-actions' },
                h('button', { className: 'dk-mini', onClick: doDraft }, 'AI 起草'),
                h('button', { className: 'dk-mini', onClick: doReply, disabled: replyText.trim() === '' }, '✓ 已回复，记录'),
                h('button', { className: 'dk-mini', onClick: () => setReplying(null) }, '取消'))) : null,
            replied.length > 0 ? h('div', { className: 'dk-field-label' }, '已回复（' + replied.length + '）') : null,
            replied.map((m) => h(MsgCard, { key: m.id, m, onDelete: () => API.msgDelete(m.id).then(reload) })),
          )))
    }

    function AddMsgForm({ onAdd }) {
      const [plat, setPlat] = useState('微博')
      const [author, setAuthor] = useState('')
      const [text, setText] = useState('')
      const [slug, setSlug] = useState('')
      return h('div', { className: 'dk-taskform', style: { maxWidth: 560 } },
        h('div', { className: 'dk-taskform-row' },
          h('select', { value: plat, onChange: (e) => setPlat(e.target.value) }, ['微博', 'X', '知乎', '小红书', 'B站', '其他'].map((p) => h('option', { key: p, value: p }, p))),
          h('input', { value: author, onChange: (e) => setAuthor(e.target.value), placeholder: '评论者昵称', style: { flex: 1 } })),
        h('textarea', { value: text, onChange: (e) => setText(e.target.value), rows: 3, placeholder: '粘贴评论原文…' }),
        h('input', { value: slug, onChange: (e) => setSlug(e.target.value), placeholder: '关联内容 slug（可空，如 一页看懂-dsh-插件开发）' }),
        h('div', { className: 'dk-taskform-row' },
          h('button', { type: 'button', onClick: () => onAdd(plat, author, text, slug), disabled: text.trim() === '' }, '添加'),
          h('span', { className: 'dk-fine', style: { alignSelf: 'center' } }, '粘进来后可 AI 起草回复')))
    }

    function MsgCard({ m, onDraft, onReply, onDelete }) {
      return h('div', { className: 'dk-card', style: { cursor: 'default' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: 'dk-chip', style: { fontSize: 11, padding: '1px 10px' } }, m.platform),
          h('b', { style: { fontSize: 14 } }, m.author),
          h('span', { className: 'dk-fine' }, m.time),
          m.status === 'replied' ? h('span', { style: { color: 'var(--dk-ok,#34d399)', fontSize: 12, fontWeight: 600 } }, '✓ 已回') : null,
          onDelete ? h('button', { className: 'dk-mini danger', style: { marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }, onClick: onDelete }, '删') : null),
        h('div', { style: { fontSize: 14, marginTop: 6, lineHeight: 1.7 } }, m.text),
        m.reply ? h('div', { style: { marginTop: 8, padding: '8px 12px', background: 'var(--color-bg-2,#1b1e26)', borderRadius: 8, fontSize: 13, opacity: .8, borderLeft: '2px solid var(--dk-ok,#34d399)' } },
          h('span', { style: { fontSize: 11, color: 'var(--dk-ok,#34d399)', fontWeight: 600 } }, '回复：'), m.reply) : null,
        m.status === 'new' ? h('div', { className: 'dk-card-actions' },
          onDraft ? h('button', { className: 'dk-mini', onClick: () => onDraft(m.id) }, '起草') : null,
          onReply ? h('button', { className: 'dk-mini', onClick: onReply }, '手写回复') : null) : null)
    }

    // 启动器弹窗
    function LauncherModal({ project, onClose }) {
      const [cli, setCli] = useState('opencode')
      const [cwd, setCwd] = useState('D:/coding')
      const [customCmd, setCustomCmd] = useState('')
      const [msg, setMsg] = useState(null)
      useEffect(() => { API.launcherGet().then((j) => { if (j && j.ok && j.launcher) { if (j.launcher.cli) setCli(j.launcher.cli); if (j.launcher.cwd) setCwd(j.launcher.cwd); if (j.launcher.customCmd) setCustomCmd(j.launcher.customCmd) } }).catch(() => {}) }, [])
      const save = (dispatch) => {
        API.launcherSet({ cli, cwd, customCmd }).then(async (j) => {
          if (!j.ok) { setMsg('保存失败：' + j.error); return }
          try { localStorage.setItem('dk-launcher-seen', '1'); window.__dkLaunchSeen = '1' } catch {}
          if (dispatch) {
            const r = await API.dispatch(project)
            window.__deckLastCmd = r.command
            setMsg(r.mode === 'terminal' ? '✓ 已开终端（' + cli + '）' : '命令已生成，复制运行')
            onClose()
          } else { setMsg('✓ 已保存'); setTimeout(onClose, 500) }
        })
      }
      return h('div', { className: 'dk-modal-back', onClick: (e) => { if (e.target.className === 'dk-modal-back') onClose() } },
        h('div', { className: 'dk-modal' },
          h('div', { className: 'dk-modal-title' }, '发给 agent · 启动器'),
          h('div', { className: 'dk-field' }, h('label', null, 'CLI'),
            h('div', { className: 'dk-launchrow' }, ['opencode', 'zcode', 'custom'].map((c) =>
              h('button', { key: c, className: 'dk-chip', style: cli === c ? { borderColor: 'var(--dk-accent)', color: 'var(--dk-accent)' } : {}, onClick: () => setCli(c) }, c === 'custom' ? '自定义命令' : c)))),
          h('div', { className: 'dk-field' }, h('label', null, '启动目录'),
            h('input', { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: 'D:/coding' })),
          cli === 'custom' ? h('div', { className: 'dk-field' }, h('label', null, '命令'), h('input', { value: customCmd, onChange: (e) => setCustomCmd(e.target.value), placeholder: '如 claude' })) : null,
          msg !== null ? h(Note, null, msg) : null,
          h('div', { className: 'dk-modal-actions' },
            h('button', { className: 'dk-ghost', onClick: onClose }, '取消'),
            h('button', { className: 'dk-ghost', onClick: () => save(false) }, '仅保存'),
            h('button', { onClick: () => save(true) }, '保存并派发'))),
      )
    }

    // ── 工作台外壳（v4 五台）──
    const APPS = [['hub', 'hub', '总台'], ['content', 'content', '内容台'], ['kb', 'kb', '知识库'], ['research', 'research', '调研台'], ['msg', 'msg', '消息台']]
    const THEMES = [['glass', '#2dd4ff'], ['term', '#39ff6e'], ['cyber', '#fcee0a'], ['paper', '#d8c9a3']]
    const FLOW_STEPS = ['灵感', '任务', '创作', '待发', '发布']
    const stepOfTask = (st) => st === 'queued' ? 1 : (st === 'running' || st === 'review') ? 2 : 4
    const stepOfContent = (st) => st === 'idea' ? 0 : st === 'drafting' ? 2 : (st === 'ready' || st === 'prefill') ? 3 : 4
    let kbGoTab = (f) => { kbPendingTab = f }
    let kbPendingTab = null
    let mediaGoItem = null
    let navigateApp = null
    function goDesk(d) { if (!isOpen()) setOpen(true); if (navigateApp !== null) navigateApp(d) }
    function goProject(id) {
      if (!isOpen()) setOpen(true)
      if (navigateApp !== null) navigateApp(id === 'builtin-kb' ? 'kb' : id === 'builtin-media' ? 'media' : 'p:' + id)
      // 打开项目 → 自动切到其绑定的会话（worktable 行为对齐）
      const p = stateStore.projects.find((x) => x.id === id)
      if (p !== undefined && p.bindSession !== undefined) openSession(p.bindSession)
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
            h(Icon, { name: icon, size: 22, className: 'dk-rail-icon' }),
            h('span', { className: 'dk-rail-label' }, label))),
        userProjects.length > 0 ? h('div', { className: 'dk-rail-sep' }) : null,
        userProjects.map((p) =>
          h('button', { key: p.id, className: 'dk-rail-btn' + (app === 'p:' + p.id ? ' on' : ''), title: p.name, onClick: () => setApp('p:' + p.id) },
            h('span', { className: 'dk-rail-icon' }, p.icon || '📁'),
            h('span', { className: 'dk-rail-label' }, p.name.slice(0, 6)))),
        h('div', { className: 'dk-rail-fill' }),
        h('div', { className: 'dk-thdots' },
          h('button', { className: 'dk-thdot', title: '\u7f29\u653e ' + (zoomStore.z * 100) + '% (\u70b9\u51fb\u5207\u6362 85/100/115/130%)',
            onClick: () => zoomStore.cycle(),
            style: { background: zoomStore.z === 1 ? 'var(--color-text-1,#e6e6e6)' : 'var(--dk-accent,#5b6cff)', color: zoomStore.z === 1 ? 'var(--color-bg-1,#14161c)' : '#fff', fontSize: '8px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, borderRadius: '50%', border: '2px solid rgba(255,255,255,.25)', cursor: 'pointer', padding: 0 } },
            Math.round(zoomStore.z * 100)),
          THEMES.map(([id, color]) =>
          h('button', { key: id, className: 'dk-thdot' + (themeStore.th === id ? ' on' : ''), style: { background: color, color }, title: '主题 ' + id, onClick: () => themeStore.set(id) }))),
        h('button', { className: 'dk-rail-btn' + (app === 'room' ? ' on' : ''), title: '控制室', onClick: () => setApp('room') },
          h(Icon, { name: 'room', size: 22, className: 'dk-rail-icon' }),
          h('span', { className: 'dk-rail-label' }, '控制室')),
        h('button', { className: 'dk-rail-btn close', title: '收起工作台', onClick: () => setOpen(false) },
          h('span', { className: 'dk-rail-icon' }, '»')),
      )
    }

    function Workspace() {
      const [app, setApp] = useState('hub')
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
          ? h('button', { className: 'dk-tile', title: '展开工作台', onClick: () => setOpen(true) }, '台')
          : null
      }
      const proj = app.startsWith('p:') ? (stateStore.projects.find((p) => p.id === app.slice(2)) ?? null) : null
      return h('div', { className: 'dk-shell', 'data-th': themeStore.th, style: { '--dk-chatw': chatStore.w + 'px', '--dk-zoom': zoomStore.z } },
        h(Rail, { app, setApp }),
        h('div', { className: 'dk-main' },
          app === 'hub' ? h(HubDesk)
          : app === 'content' ? h(MediaDesk)
          : app === 'kb' ? h(KnowledgeDesk)
          : app === 'research' ? h('div', { className: 'dk-desk' },
              h('div', { className: 'dk-deskbar' },
                h('button', { className: 'on' }, '调研任务 · 知识库项目'),
                h('span', { className: 'dk-fine', style: { alignSelf: 'center', marginLeft: 6 } }, 'TASK.md 队列 → 发给 agent → 审阅落库')),
              h('div', { className: 'dk-deskmain' }, h(TaskBoard, { projectId: 'builtin-kb', onGoReview: () => { setApp('kb'); if (kbGoTab) kbGoTab('review') } })))
          : app === 'msg' ? h(MsgDesk)
          : app === 'room' ? h(ControlRoom)
          : proj !== null ? h(GenericDesk, { project: proj })
          : h('div', { className: 'dk-empty' }, h('div', { className: 'dk-empty-title' }, '项目不存在（可能已删除）'))),
        h(SessBar),
        h(FloatLayer),
        h('div', { className: 'dk-chatdiv', title: '拖动调右侧对话区宽度 · 双击复位', onPointerDown: (e) => {
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const mv = (ev) => { chatStore.setW(Math.min(window.innerWidth * .55, Math.max(280, window.innerWidth - ev.clientX))) }
          const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up) }
          el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up)
        }, onDoubleClick: () => chatStore.setW(420) }),
        window.__dkNeedLaunch ? h(LauncherModal, { project: window.__dkDispatchProject || 'builtin-kb', onClose: () => { window.__dkNeedLaunch = false; notify() } }) : null,
      )
    }

    const ZOOMS = [0.85, 1, 1.15, 1.3]
    const zoomStore = { z: Number(localStorage.getItem('dk-zoom')) || 1, set(v) { this.z = v; try { localStorage.setItem('dk-zoom', String(v)) } catch {} notify() }, cycle() { const i = ZOOMS.indexOf(this.z); this.set(ZOOMS[(i + 1) % ZOOMS.length]) } }
    const themeStore = { th: (() => { try { return localStorage.getItem('dk-theme') || 'glass' } catch { return 'glass' } })(), set(t) { this.th = t; try { localStorage.setItem('dk-theme', t) } catch {} notify() } }
    const chatStore = { w: Number(localStorage.getItem('dk-chatw')) || 420, setW(v) { this.w = Math.round(v); try { localStorage.setItem('dk-chatw', String(this.w)) } catch {} notify() } }

    // ── W1 浮窗引擎：窗口栈 + localStorage 持久化（dsh-deck.windows.v1）──
    const WIN_LS = 'dsh-deck.windows.v1'
    const winStore = {
      list: (() => { try { const raw = localStorage.getItem(WIN_LS); const arr = raw !== null ? JSON.parse(raw) : []; return Array.isArray(arr) ? arr.filter((w) => w && typeof w.id === 'string' && typeof w.path === 'string') : [] } catch { return [] } })(),
      zTop: 100,
      save() { try { localStorage.setItem(WIN_LS, JSON.stringify(this.list.slice(0, 12))) } catch {} },
      open({ title, root, path }) {
        const n = this.list.length
        const w = { id: 'w' + Date.now().toString(36) + n, title: String(title || path).slice(0, 60), root, path,
          x: 90 + (n % 6) * 36, y: 56 + (n % 6) * 30, w: 660, h: 480, min: false, max: false, z: ++this.zTop }
        this.list = [...this.list.slice(-11), w]
        this.save(); notify()
        return w.id
      },
      close(id) { this.list = this.list.filter((w) => w.id !== id); this.save(); notify() },
      patch(id, p) { this.list = this.list.map((w) => w.id === id ? Object.assign({}, w, p) : w); this.save(); notify() },
      front(id) { this.list = this.list.map((w) => w.id === id ? Object.assign({}, w, { z: ++this.zTop }) : w); this.save(); notify() },
    }

    function FloatWin({ w }) {
      const onTitleDown = (e) => {
        if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return
        winStore.front(w.id)
        if (w.max) return
        const el = e.currentTarget
        try { el.setPointerCapture(e.pointerId) } catch {}
        const dx = e.clientX - w.x, dy = e.clientY - w.y
        const mv = (ev) => { winStore.patch(w.id, { x: Math.max(-w.w + 120, ev.clientX - dx), y: Math.max(0, ev.clientY - dy) }) }
        const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up) }
        el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up)
      }
      const onResizeDown = (e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        winStore.front(w.id)
        const el = e.currentTarget
        try { el.setPointerCapture(e.pointerId) } catch {}
        const sw = w.w, sh = w.h, sx = e.clientX, sy = e.clientY
        const mv = (ev) => { winStore.patch(w.id, { max: false, w: Math.max(320, sw + ev.clientX - sx), h: Math.max(200, sh + ev.clientY - sy) }) }
        const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up) }
        el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up)
      }
      const style = w.max
        ? { left: 12, top: 12, right: 12, bottom: 12, zIndex: w.z }
        : { left: w.x, top: w.y, width: w.w, height: w.min ? 'auto' : w.h, zIndex: w.z }
      return h('div', { className: 'dk-win' + (w.max ? ' max' : ''), style, onPointerDown: () => winStore.front(w.id) },
        h('div', { className: 'dk-win-head', onPointerDown: onTitleDown, onDoubleClick: () => winStore.patch(w.id, { max: !w.max }) },
          h('span', { className: 'dk-win-title' }, w.title),
          h('span', { className: 'dk-win-btns' },
            h('button', { title: '最小化', onClick: () => winStore.patch(w.id, { min: !w.min }) }, w.min ? '▢' : '–'),
            h('button', { title: '最大化', onClick: () => winStore.patch(w.id, { max: !w.max }) }, '▢'),
            h('button', { title: '关闭', onClick: () => winStore.close(w.id) }, '×'))),
        w.min ? null : h('div', { className: 'dk-win-body' },
          h(Preview, { root: w.root, path: w.path, title: w.title, onBack: () => winStore.close(w.id) })),
        w.min || w.max ? null : h('div', { className: 'dk-win-resize', onPointerDown: onResizeDown }))
    }

    function FloatLayer() {
      if (winStore.list.length === 0) return null
      return h('div', { className: 'dk-floatlayer' },
        winStore.list.map((w) => h(FloatWin, { key: w.id, w })))
    }

    function SessBar() {
      const rows = sessionsStore.ids.map((id) => sessionsStore.byId[id]).filter(Boolean)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, 12)
      return h('div', { className: 'dk-sessbar' },
        h('div', { className: 'sbh' }, '会话'),
        h('div', { className: 'sbl' },
          rows.map((ss) =>
            h('button', { key: ss.id, style: { textAlign: 'left', width: '100%', background: 'var(--color-bg-2)', border: '1px solid ' + (ss.id === sessionsStore.current ? 'var(--dk-accent)' : 'var(--color-border-1)'), color: 'inherit', borderRadius: 9, padding: '6px 10px', cursor: 'pointer', font: 'inherit' }, onClick: () => openSession(ss.id), title: ss.cwd || '' },
              h('div', { style: { fontWeight: 600, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: ss.running ? 'var(--dk-accent)' : undefined } }, (ss.running ? '🏃 ' : '') + sessTitle(ss)),
              h('div', { style: { fontSize: 10.5, opacity: .5, fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (ss.cwd || '').split(/[\/]/).pop() || ''))),
          h('button', { className: 'dk-mini', style: { alignSelf: 'flex-start' }, onClick: async () => {
            try { const sid = await createSessionFor('D:/coding'); openSession(sid) } catch (e) { window.alert(String((e && e.message) || e)) }
          } }, '＋ 新会话')),
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
  color:inherit;font:12.5px/1.6 system-ui;cursor:pointer;padding:3px 13px;}
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
.dk-card-title{font-weight:650;font-size:13.5px;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-card-sub{font-size:11.5px;opacity:.5;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-card-snip{font-size:12px;opacity:.8;margin-top:6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.dk-card-snip mark{background:color-mix(in srgb,var(--dk-accent,#5b6cff) 35%,transparent);color:inherit;border-radius:2px;padding:0 1px;}
.dk-card-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;}
.dk-mini{background:var(--color-bg-2,#1b1e26);color:var(--dk-accent,#5b6cff);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:8px;font:12px/1.7 system-ui;cursor:pointer;padding:3px 11px;}
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
.dk-room-status{font-size:11.5px;opacity:.45;margin-top:6px;}
.dk-card.room{cursor:default;text-align:left;display:flex;flex-direction:column;gap:6px;}
.dk-card.room.add{border-style:dashed;opacity:.6;cursor:pointer;}
.dk-card.room.add:hover{opacity:1;border-color:var(--dk-accent,#5b6cff);}
.dk-card.hidden{opacity:.45;}
.dk-counts{display:flex;gap:10px;font-size:11.5px;opacity:.75;flex-wrap:wrap;}
.dk-bind{align-self:flex-start;background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);border-radius:8px;
  color:inherit;font:12px/1.7 system-ui;cursor:pointer;padding:3px 11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-bind.cur{color:#34d399;border-color:#34d39955;}
.dk-bind:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-picker{background:var(--color-bg-2,#1b1e26);border:1px solid var(--color-border-1,#2a2e37);border-radius:10px;
  padding:8px;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;}
.dk-picker-head{font-size:11.5px;opacity:.55;margin-bottom:2px;}
.dk-sessrow{display:flex;flex-direction:column;gap:0;background:none;border:none;color:inherit;text-align:left;
  border-radius:8px;padding:5px 8px;cursor:pointer;font:inherit;}
.dk-sessrow:hover{background:var(--color-bg-3,#232732);}
.dk-sessrow.cur{box-shadow:inset 0 0 0 1px var(--dk-accent,#5b6cff);}
.dk-sessrow-t{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-sessrow-c{font-size:11.5px;opacity:.45;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-sesscard{display:flex;flex-direction:column;gap:2px;background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:10px;color:inherit;text-align:left;font:inherit;cursor:pointer;padding:7px 10px;}
.dk-sesscard:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-sesscard.cur{box-shadow:inset 0 0 0 1px var(--dk-accent,#5b6cff);}
.dk-note{opacity:.6;font-size:12.5px;padding:2px 2px;}
.dk-err{color:#f87171;opacity:1;}
.dk-preview{display:flex;flex-direction:column;gap:8px;max-width:860px;}
.dk-preview-head{display:flex;align-items:center;gap:8px;}
.dk-path{font-family:ui-monospace,monospace;font-size:11.5px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
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
.dk-empty-title{font-weight:650;font-size:15px;}
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
.dk-taskform button[type=submit]{background:var(--dk-accent,#5b6cff);color:#fff;border:none;border-radius:10px;
  padding:8px 18px;cursor:pointer;font:inherit;font-weight:600;}
.dk-badge{display:inline-block;font-size:11.5px;border-radius:999px;padding:1px 10px;margin-top:6px;
  border:1px solid var(--color-border-1,#2a2e37);opacity:.9;}
.dk-badge.wait{color:#fbbf24;border-color:#fbbf2444;}
.dk-badge.run{color:#60a5fa;border-color:#60a5fa44;}
.dk-badge.rev{color:#c084fc;border-color:#c084fc44;}
.dk-badge.ok{color:#34d399;border-color:#34d39944;}
.dk-badge.bad{color:#f87171;border-color:#f8717144;}
.dk-task-acc{margin:6px 0 0;padding-left:1.3em;font-size:11.5px;opacity:.7;}
.dk-task-acc li{margin:1px 0;}
.dk-card.task{cursor:default;}
.dk-reviewbox{background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:12px;
  padding:14px 16px;max-width:860px;display:flex;flex-direction:column;gap:10px;}
.dk-field-label{font-size:12.5px;font-weight:600;opacity:.7;}
.dk-check{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border:1px solid var(--color-border-1,#2a2e37);
  border-radius:10px;cursor:pointer;font-size:12.5px;margin:3px 0;}
.dk-check:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-check.on{border-color:var(--dk-accent,#5b6cff);background:color-mix(in srgb,var(--dk-accent,#5b6cff) 8%,transparent);}
.dk-check input{margin-top:3px;accent-color:var(--dk-accent,#5b6cff);}
.dk-widgets{display:flex;flex-direction:column;gap:8px;}
.dk-widget{border:1px solid var(--color-border-1,#2a2e37);border-radius:10px;overflow:hidden;}
.dk-frame{width:100%;height:280px;border:none;background:#fff;}
.dk-details summary{cursor:pointer;font-size:12.5px;opacity:.6;}
.dk-details[open] summary{margin-bottom:6px;}
.dk-modal-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:70;display:flex;align-items:center;justify-content:center;}
.dk-modal{width:min(440px,92vw);background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.5);}
.dk-modal.wide{width:min(720px,94vw);max-height:88vh;overflow-y:auto;}
.dk-modal.wide .dk-modal-actions{position:sticky;bottom:-18px;margin-top:auto;padding:10px 0 2px;
  background:var(--color-bg-1,#14161c);border-top:1px solid var(--color-border-1,#2a2e37);}
@media (max-height:780px){.dk-frame{height:190px;}}
@media (max-width:1100px){.dk-board{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));}}
.dk-modal-title{font-weight:700;font-size:15px;}
.dk-field{display:flex;flex-direction:column;gap:4px;font-size:12.5px;}
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
.dk-board.media{grid-template-columns:repeat(auto-fit,minmax(200px,1fr));}
.dk-filechips{display:flex;flex-wrap:wrap;gap:6px;}
.dk-board-col{background:color-mix(in srgb,var(--color-bg-1,#14161c) 60%,transparent);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px;min-height:140px;}
.dk-board-colhead{font-size:12.5px;font-weight:600;opacity:.7;padding:2px 4px 4px;}
.dk-chip-task{display:flex;flex-direction:column;gap:2px;background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);
  border-radius:10px;color:inherit;text-align:left;font:inherit;cursor:pointer;padding:7px 10px;}
.dk-chip-task:hover{border-color:var(--dk-accent,#5b6cff);}
.dk-chip-task-t{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-chip-task-p{font-size:11.5px;opacity:.55;}
`
      const el = document.createElement('style')
      el.id = 'dsh-deck-style'
      el.textContent = css + `
/* ═══ 展开动画+组件层级优化 ═══ */
.dk-main > .dk-desk{animation:deskSlideIn .22s cubic-bezier(.25,.46,.45,.94);}
@keyframes deskSlideIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
.dk-todo{animation:cardIn .3s cubic-bezier(.25,.46,.45,.94) both;}
.dk-todo:nth-child(2){animation-delay:.06s;}
.dk-todo:nth-child(3){animation-delay:.12s;}
@keyframes cardIn{from{opacity:0;transform:translateX(-12px);}to{opacity:1;transform:none;}}
.dk-flowrow{animation:rowIn .25s ease both;}
.dk-flowrow:nth-child(2){animation-delay:.04s;}
.dk-flowrow:nth-child(3){animation-delay:.08s;}
@keyframes rowIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
.dk-modal-back{animation:fadeIn .15s ease;}
.dk-modal{animation:modalIn .22s cubic-bezier(.34,1.2,.64,1);}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes modalIn{from{opacity:0;transform:scale(.94) translateY(10px);}to{opacity:1;transform:none;}}
.dk-card{transition:transform .16s cubic-bezier(.25,.46,.45,.94),border-color .16s,box-shadow .16s;}
.dk-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.25);}
.dk-idea{transition:transform .18s cubic-bezier(.34,1.3,.64,1),border-color .18s;}
.dk-idea:hover{transform:translateY(-3px) scale(1.02);}
.dk-sessbar .sess{transition:transform .14s ease,border-color .14s,box-shadow .14s;}
.dk-sessbar .sess:hover{transform:translateX(-2px);}
.dk-field-label{letter-spacing:.3px;text-transform:none;}
/* 层级尺寸规范 */
.dk-todo .nm{font-weight:700;}
.dk-todo .pv{font-weight:400;}
.dk-flowrow .ftt{font-weight:600;}
.dk-step.now{text-shadow:0 0 8px color-mix(in srgb,var(--dk-accent,#5b6cff) 40%,transparent);}
/* 统计卡数字强调 */
.dk-shell .stat .v,.dk-shell [style*="fontWeight: 750"],.dk-shell [style*="fontWeight:750"]{font-variant-numeric:tabular-nums;letter-spacing:-.5px;}
/* 按钮触感 */
button{transition:transform .1s ease,filter .1s ease,box-shadow .15s ease;}
button:active{transform:scale(.97);}
` + `/* ═══ 缩放系统 ═══ */
.dk-shell{font-size:calc(13px * var(--dk-zoom,1)) !important;}
.dk-shell .dk-icon-svg{width:calc(18px * var(--dk-zoom,1));height:calc(18px * var(--dk-zoom,1));}
.dk-shell .dk-rail-btn .dk-icon-svg{width:calc(22px * var(--dk-zoom,1));height:calc(22px * var(--dk-zoom,1));}
.dk-shell .dk-card{padding:calc(12px * var(--dk-zoom,1)) calc(14px * var(--dk-zoom,1));}
.dk-shell .dk-deskbar button{font-size:calc(12.5px * var(--dk-zoom,1));}
.dk-shell .dk-searchbar input{font-size:calc(13px * var(--dk-zoom,1));}
.dk-shell .dk-note{font-size:calc(12.5px * var(--dk-zoom,1));}
.dk-shell .dk-card-title{font-size:calc(13.5px * var(--dk-zoom,1));}
.dk-shell .dk-card-sub{font-size:calc(11.5px * var(--dk-zoom,1));}
.dk-shell .dk-mini{font-size:calc(12px * var(--dk-zoom,1));}
.dk-shell .dk-grid{gap:calc(10px * var(--dk-zoom,1));grid-template-columns:repeat(auto-fill,minmax(calc(300px * var(--dk-zoom,1)),1fr));}
.dk-shell .dk-rail{width:calc(84px * var(--dk-zoom,1));}
.dk-shell .dk-todo .nm{font-size:calc(15.5px * var(--dk-zoom,1));}
.dk-shell .dk-todo .pv{font-size:calc(13.5px * var(--dk-zoom,1));}
.dk-shell .dk-h1{font-size:calc(21px * var(--dk-zoom,1));}
@media (max-width:1400px){.dk-shell .dk-grid{grid-template-columns:repeat(auto-fill,minmax(calc(260px * var(--dk-zoom,1)),1fr));}}
@media (max-width:1100px){.dk-shell .dk-grid{grid-template-columns:1fr;}.dk-shell .dk-board{grid-template-columns:repeat(2,1fr);}}
@media (max-width:800px){.dk-shell .dk-board{grid-template-columns:1fr;}.dk-shell .dk-rail{width:calc(64px * var(--dk-zoom,1));}}` + `
/* ═══ SVG 图标 + 动画系统 ═══ */
.dk-icon-svg{display:inline-block;vertical-align:middle;transition:transform .18s ease,filter .18s ease,opacity .18s ease;}
.dk-icon-svg:hover{transform:scale(1.12);filter:drop-shadow(0 0 4px color-mix(in srgb,var(--dk-accent,#5b6cff) 60%,transparent));}
.dk-rail-btn .dk-icon-svg{transition:transform .2s cubic-bezier(.34,1.56,.64,1),filter .2s ease;}
.dk-rail-btn:hover .dk-icon-svg{transform:scale(1.18) translateY(-1px);filter:drop-shadow(0 0 6px color-mix(in srgb,var(--dk-accent,#5b6cff) 70%,transparent));}
.dk-rail-btn.on .dk-icon-svg{transform:scale(1.1);filter:drop-shadow(0 0 8px color-mix(in srgb,var(--dk-accent,#5b6cff) 80%,transparent));animation:iconPulse 2.4s ease-in-out infinite;}
@keyframes iconPulse{0%,100%{filter:drop-shadow(0 0 4px color-mix(in srgb,var(--dk-accent,#5b6cff) 50%,transparent));}50%{filter:drop-shadow(0 0 10px color-mix(in srgb,var(--dk-accent,#5b6cff) 90%,transparent));}}
.dk-deskbar button .dk-icon-svg{transition:transform .15s ease;}
.dk-deskbar button:hover .dk-icon-svg{transform:scale(1.15) rotate(-5deg);}
.dk-deskbar button.on .dk-icon-svg{transform:scale(1.1);animation:iconBounce .3s ease;}
@keyframes iconBounce{0%{transform:scale(.8);}60%{transform:scale(1.2);}100%{transform:scale(1.1);}}
.dk-card-actions .dk-icon-svg,.dk-mini .dk-icon-svg{transition:transform .12s ease;}
.dk-card-actions button:hover .dk-icon-svg,.dk-mini:hover .dk-icon-svg{transform:scale(1.2) rotate(8deg);}
.dk-brand{animation:brandFloat 3s ease-in-out infinite;}
@keyframes brandFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-2px);}}
.dk-loading{animation:spin 1s linear infinite;}
@keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
.dk-rail-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center;}
` + `/* ═══ v4：Hub/会话右条/主题/启动器 ═══ */
.dk-todo{display:flex;align-items:center;gap:14px;padding:14px 20px;}
.dk-todo.urgent{border-color:rgba(251,191,36,.5);background:linear-gradient(145deg,rgba(251,191,36,.10),transparent 60%),var(--color-bg-1,#14161c);}
.dk-todo .ico{font-size:24px;}.dk-todo .nm{font-size:15.5px;font-weight:700;}
.dk-todo .pv{flex:1;font-size:13.5px;opacity:.7;border-left:2px solid var(--color-border-1,#2a2e37);padding-left:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-flowrow{display:flex;align-items:center;gap:14px;background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:13px;padding:12px 18px;}
.dk-flowrow .ftt{font-size:14.5px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-steps{display:flex;align-items:center;flex-shrink:0;}
.dk-step{display:flex;align-items:center;gap:5px;font-size:11.5px;opacity:.6;white-space:nowrap;}
.dk-step i{width:17px;height:17px;border-radius:50%;border:1.5px solid var(--color-border-1,#2a2e37);display:flex;align-items:center;justify-content:center;font-style:normal;font-size:9.5px;}
.dk-step.done i{border-color:var(--dk-ok,#34d399);color:var(--dk-ok,#34d399);}
.dk-step.now{opacity:1;color:var(--dk-accent,#5b6cff);font-weight:650;}
.dk-step.now i{background:var(--dk-accent,#5b6cff);color:#fff;border-color:transparent;}
.dk-stepline{width:16px;height:1px;background:var(--color-border-1,#2a2e37);margin:0 4px;}
.dk-stepline.done{background:var(--dk-ok,#34d399);}
.dk-shell{right:var(--dk-chatw,420px);}
.dk-sessbar{width:230px;flex-shrink:0;border-left:1px solid var(--color-border-1,#2a2e37);background:var(--color-bg-1,#14161c);display:flex;flex-direction:column;min-height:0;}
.dk-sessbar .sbh{height:44px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--color-border-1,#2a2e37);font-size:13.5px;font-weight:650;flex-shrink:0;}
.dk-sessbar .sbl{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:5px;min-height:0;}
.dk-chatdiv{position:absolute;top:0;right:-7px;bottom:0;width:7px;cursor:col-resize;z-index:8;}
.dk-chatdiv::after{content:'';position:absolute;left:3px;top:0;bottom:0;width:1px;background:var(--color-border-1,#2a2e37);}
.dk-chatdiv:hover::after{width:3px;background:var(--dk-accent,#5b6cff);}
.dk-thdots{display:flex;flex-direction:column;gap:7px;align-items:center;padding-top:10px;}
.dk-thdot{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;padding:0;}
.dk-thdot.on{border-color:#fff;box-shadow:0 0 0 2px var(--color-bg-1,#14161c),0 0 10px 1px currentColor;}
.dk-shell[data-th="glass"]{--color-bg-0:#050a18;--color-bg-1:rgba(120,190,255,.07);--color-bg-2:rgba(120,190,255,.12);--color-bg-3:rgba(120,190,255,.16);--color-border-1:rgba(140,200,255,.18);--color-text-1:#e3f0ff;--dk-accent:#2dd4ff;--dk-ok:#34d399;}
.dk-shell[data-th="term"]{--color-bg-0:#080d09;--color-bg-1:#0b120d;--color-bg-2:#0f1a12;--color-bg-3:#14241a;--color-border-1:#1d3a24;--color-text-1:#c8f2cf;--dk-accent:#39ff6e;--dk-ok:#39ff6e;font-family:ui-monospace,Consolas,monospace;}
.dk-shell[data-th="cyber"]{--color-bg-0:#0b0b10;--color-bg-1:#12121a;--color-bg-2:#181824;--color-bg-3:#1f1f2e;--color-border-1:#2a2a3a;--color-text-1:#f2f2f8;--dk-accent:#fcee0a;--dk-ok:#00f0aa;}
.dk-shell[data-th="paper"]{--color-bg-0:#f6f1e7;--color-bg-1:#fffdf8;--color-bg-2:#f4eee1;--color-bg-3:#ece4d2;--color-border-1:#ddd4c2;--color-text-1:#26211a;--dk-accent:#b03a2e;--dk-ok:#3d7a4f;}
.dk-launchrow{display:flex;gap:10px;flex-wrap:wrap;}
/* ═══ W1 浮窗引擎 ═══ */
.dk-floatlayer{position:absolute;inset:0;z-index:70;pointer-events:none;}
.dk-win{position:absolute;pointer-events:auto;display:flex;flex-direction:column;background:var(--color-bg-1,#14161c);border:1px solid var(--color-border-1,#2a2e37);border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;min-width:320px;min-height:200px;}
.dk-win-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;user-select:none;background:var(--color-bg-2,#1b1e26);border-bottom:1px solid var(--color-border-1,#2a2e37);flex-shrink:0;}
.dk-win-title{flex:1;font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-win-btns{display:flex;gap:4px;}
.dk-win-btns button{background:none;border:none;color:inherit;font-size:13px;cursor:pointer;padding:2px 8px;border-radius:6px;opacity:.7;}
.dk-win-btns button:hover{opacity:1;background:var(--color-bg-3,#232732);}
.dk-win-body{flex:1;overflow-y:auto;padding:12px 14px;min-height:0;}
.dk-win-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;}
.dk-win-resize::after{content:'';position:absolute;right:4px;bottom:4px;width:8px;height:8px;border-right:2px solid var(--color-border-1,#2a2e37);border-bottom:2px solid var(--color-border-1,#2a2e37);}`
      document.head.appendChild(el)
    }

    // 调试后门：本地渲染台/回归脚本直接渲染各台面（只读）
    try { window.__dkDebug = { MediaDesk, KnowledgeDesk, ControlRoom, ReviewFlow, TaskBoard } } catch {}

    const inject = ['slots', 'sessions', 'conversation']
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
          }, '台')))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
