/**
 * Single-file HTML dashboard generator.
 *
 * Reads the zvec store directly (no engine, no embedding), emits a
 * self-contained HTML with: stat tiles, filterable memory cards grouped by
 * project, and per-card detail. Dark/light themes via prefers-color-scheme +
 * manual toggle. No server, no network — one file.
 *
 * The HTML template uses a %%PAYLOAD%% placeholder so the embedded JS can use
 * its own template literals without colliding with this file's backticks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR } from '../core/paths.js';
import { ZvecStore } from './zvec-store.js';

interface MemoryRow {
  id: string;
  text: string;
  type: string;
  project: string;
  agent: string;
  created_at: number;
  accessed_at: number;
  strength: number;
}

export interface DashboardPayload {
  generatedAt: string;
  dataDir: string;
  total: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  memories: MemoryRow[];
}

/** Read the store directly and build the dashboard payload.
 *
 * If a store is passed (e.g. the HTTP server's already-open engine.store),
 * use it instead of opening a new one — avoids zvec's single-writer lock. */
export function buildPayload(storeIn?: { scan(): [MemoryRow, number][]; count(): number }): DashboardPayload {
  const memories: MemoryRow[] = [];
  if (storeIn) {
    memories.push(...storeIn.scan().map(([r]) => r));
  } else {
    const colPath = path.join(APP_DIR, 'memories');
    if (fs.existsSync(colPath)) {
      const store = new ZvecStore(APP_DIR, 1, { skipDimCheck: true });
      try {
        memories.push(...store.scan().map(([r]) => r));
      } finally {
        store.close();
      }
    }
  }
  // Sort newest first
  memories.sort((a, b) => b.created_at - a.created_at);

  const byType: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  for (const m of memories) {
    byType[m.type] = (byType[m.type] ?? 0) + 1;
    byProject[m.project] = (byProject[m.project] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    dataDir: APP_DIR,
    total: memories.length,
    byType,
    byProject,
    memories,
  };
}

/** Render the payload into a single self-contained HTML string. */
export function renderHtml(p: DashboardPayload): string {
  const html = HTML_TEMPLATE;
  return html.replace('%%PAYLOAD%%', JSON.stringify(p).replace(/</g, '\\u003c'));
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hippo — memory store</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --ink-1: #0b0b0b; --ink-2: #52514e; --ink-muted: #898781;
    --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
    --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #898781;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-muted: #898781;
      --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
      --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #898781;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19; --page: #0d0d0d;
    --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-muted: #898781;
    --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #898781;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--page); color: var(--ink-1);
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.5; padding: 24px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  h1 { font-size: 22px; font-weight: 700; }
  .sub { color: var(--ink-muted); font-size: 12px; }
  .theme-btn {
    margin-left: auto; background: var(--surface-1); color: var(--ink-2);
    border: 1px solid var(--border); border-radius: 8px; padding: 4px 12px;
    cursor: pointer; font-size: 12px;
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap: 10px; margin: 16px 0; }
  .tile {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 14px; position: relative; overflow: hidden;
  }
  .tile::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; opacity:.7; }
  .tile:nth-child(1)::before { background: var(--s1); }
  .tile:nth-child(2)::before { background: var(--s2); }
  .tile:nth-child(3)::before { background: var(--s3); }
  .tile:nth-child(4)::before { background: var(--s4); }
  .tile b { display: block; font-size: 26px; font-weight: 700; letter-spacing: -.5px; }
  .tile span { color: var(--ink-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 8px; align-items: center; }
  .filters .label { color: var(--ink-muted); font-size: 11px; text-transform: uppercase; margin-right: 4px; }
  .chip {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 999px;
    padding: 3px 10px 3px 22px; font-size: 12px; cursor: pointer; user-select: none;
    position: relative;
  }
  .chip::before { content:''; position:absolute; left:9px; top:50%; transform:translateY(-50%); width:8px; height:8px; border-radius:50%; background: var(--ink-muted); }
  .chip[data-type="fact"]::before        { background: var(--s1); }
  .chip[data-type="decision"]::before    { background: var(--s2); }
  .chip[data-type="lesson"]::before      { background: var(--s3); }
  .chip[data-type="preference"]::before  { background: var(--s4); }
  .chip b { font-weight: 700; margin-left: 4px; }
  .chip.active { border-color: var(--ink-1); background: var(--grid); }
  input.search {
    width: 100%; padding: 10px 14px; font-size: 14px; margin: 10px 0;
    background: var(--surface-1); color: var(--ink-1); border: 1px solid var(--border); border-radius: 8px;
  }
  input.search:focus { outline: none; border-color: var(--s1); }
  .group { margin: 18px 0; }
  .group h3 { font-size: 13px; color: var(--ink-2); margin-bottom: 8px; text-transform: uppercase; letter-spacing: .5px; }
  .cards { display: grid; gap: 8px; }
  .card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 14px; position: relative; overflow: hidden;
  }
  .card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; }
  .card[data-type="fact"]::before        { background: var(--s1); }
  .card[data-type="decision"]::before    { background: var(--s2); }
  .card[data-type="lesson"]::before      { background: var(--s3); }
  .card[data-type="preference"]::before  { background: var(--s4); }
  .card .text { font-size: 14px; margin-bottom: 6px; word-break: break-word; }
  .card .meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--ink-muted); }
  .card .meta .type { font-weight: 600; text-transform: uppercase; }
  .card .meta .strength { color: var(--ink-2); }
  .empty { text-align: center; padding: 60px 20px; color: var(--ink-muted); }
  footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--ink-muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🦛 hippo</h1>
    <span class="sub" id="sub">memory store</span>
    <button class="theme-btn" onclick="toggleTheme()">theme</button>
  </header>
  <div class="tiles" id="tiles"></div>
  <input class="search" id="search" placeholder="filter memories (text)…" oninput="render()">
  <div class="filters"><span class="label">type</span><span id="type-chips"></span></div>
  <div class="filters"><span class="label">project</span><span id="project-chips"></span></div>
  <div id="list"></div>
  <footer id="footer"></footer>
</div>
<script>
const DATA = %%PAYLOAD%%;
let activeType = null, activeProject = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}
function fmtTs(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function toggleTheme() {
  var cur = document.documentElement.dataset.theme;
  var isDark = cur === 'dark' || (!cur && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = isDark ? 'light' : 'dark';
}

function renderTiles() {
  var types = Object.keys(DATA.byType).sort();
  var oldest = DATA.memories.length ? fmtTs(DATA.memories[DATA.memories.length-1].created_at) : '—';
  var tiles = [
    ['memories', DATA.total],
    ['projects', Object.keys(DATA.byProject).length],
    ['types', types.length],
    ['oldest', oldest]
  ];
  document.getElementById('tiles').innerHTML = tiles.map(function (t) {
    return '<div class="tile"><b>' + t[1] + '</b><span>' + t[0] + '</span></div>';
  }).join('');
}

function renderChips() {
  var typeHtml = Object.keys(DATA.byType).sort().map(function (t) {
    return '<span class="chip" data-type="' + t + '" onclick="toggleType(\\'' + t + '\\')">' + t + ' <b>' + DATA.byType[t] + '</b></span>';
  }).join('');
  document.getElementById('type-chips').innerHTML = typeHtml || '<span class="sub">—</span>';

  var projHtml = Object.keys(DATA.byProject).sort().map(function (p) {
    return '<span class="chip" data-project="' + escapeHtml(p) + '" onclick="toggleProject(\\'' + p.replace(/'/g, "\\\\'") + '\\')">' + escapeHtml(p) + ' <b>' + DATA.byProject[p] + '</b></span>';
  }).join('');
  document.getElementById('project-chips').innerHTML = projHtml || '<span class="sub">—</span>';
}

function toggleType(t) {
  activeType = activeType === t ? null : t;
  document.querySelectorAll('.chip[data-type]').forEach(function (x) {
    x.classList.toggle('active', x.dataset.type === activeType);
  });
  render();
}
function toggleProject(p) {
  activeProject = activeProject === p ? null : p;
  document.querySelectorAll('.chip[data-project]').forEach(function (x) {
    x.classList.toggle('active', x.dataset.project === activeProject);
  });
  render();
}

function render() {
  var q = document.getElementById('search').value.trim().toLowerCase();
  var mems = DATA.memories.filter(function (m) {
    if (activeType && m.type !== activeType) return false;
    if (activeProject && m.project !== activeProject) return false;
    if (q && m.text.toLowerCase().indexOf(q) === -1) return false;
    return true;
  });

  var groups = {};
  mems.forEach(function (m) { (groups[m.project] = groups[m.project] || []).push(m); });
  var order = Object.keys(groups).sort();

  var list = document.getElementById('list');
  if (mems.length === 0) {
    list.innerHTML = '<div class="empty">no memories match the current filters.</div>';
  } else {
    list.innerHTML = order.map(function (proj) {
      var cards = groups[proj].map(function (m) {
        return '<div class="card" data-type="' + m.type + '">' +
          '<div class="text">' + escapeHtml(m.text) + '</div>' +
          '<div class="meta">' +
            '<span class="type">' + m.type + '</span>' +
            (m.agent ? '<span>' + escapeHtml(m.agent) + '</span>' : '') +
            '<span class="strength">str ' + m.strength.toFixed(2) + '</span>' +
            '<span>' + fmtTs(m.created_at) + '</span>' +
            (m.accessed_at !== m.created_at ? '<span>↻ ' + fmtTs(m.accessed_at) + '</span>' : '') +
            '<span class="sub" title="' + m.id + '">' + m.id.slice(0,8) + '</span>' +
          '</div></div>';
      }).join('');
      return '<div class="group"><h3>' + escapeHtml(proj) + ' · ' + groups[proj].length + '</h3><div class="cards">' + cards + '</div></div>';
    }).join('');
  }
  document.getElementById('sub').textContent = mems.length + ' of ' + DATA.total + ' memories';
}

renderTiles();
renderChips();
render();
document.getElementById('footer').textContent =
  'generated ' + new Date(DATA.generatedAt).toLocaleString() + ' · ' + DATA.dataDir + ' · hippo-skills';
</script>
</body>
</html>`;
