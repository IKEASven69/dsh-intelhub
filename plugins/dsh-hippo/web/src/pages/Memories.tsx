import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, MessagesSquare, Plus, RefreshCw, X , Brain, BarChart3, TrendingUp , Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import EmptyState from '../components/EmptyState';
import { api, MEMORY_TYPES, type MemoryRecord, type MemoryType, type SessionListItem, type Stats, toDateStr } from '../api';
import { useDetail } from '../components/DetailDrawer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import FolderPicker, { underPath } from '../components/FolderPicker';
import Pagination from '../components/Pagination';
import type { MemoryValueReport } from '../api';
import FadeIn from '../components/anim/FadeIn';
import GradientText from '../components/anim/GradientText';
import SpotlightCard from '../components/anim/SpotlightCard';
import { AgentIcon, agentLabel } from '../components/AgentIcon';

const PAGE = 50;

export default function MemoriesPage() {
  const { t } = useTranslation();
  const { openDetail } = useDetail();
  const [stats, setStats] = useState<Stats | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [filterType, setFilterType] = useState<string>('');
  const [filterProject, setFilterProject] = useState<string>('');
  const [filterAgent, setFilterAgent] = useState<string>('');
  const [filterDir, setFilterDir] = useState<string>('');
  const [filterMonth, setFilterMonth] = useState<string>('');
  const [allAgents, setAllAgents] = useState<[string, number][]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [valueReport, setValueReport] = useState<MemoryValueReport | null>(null);
  const [showValue, setShowValue] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importRaw, setImportRaw] = useState('');
  const [importPreview, setImportPreview] = useState<{ preview: { total: number; recognized: number; skipped: number }; candidates?: Array<{ text: string; type: string; project: string }> } | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const [allMems, setAllMems] = useState<MemoryRecord[]>([]);
  // 拉一次全量记忆派生 agent 列表 + 月份分布（不被当前筛选影响）
  useEffect(() => {
    void api.listMemories({ limit: 500 }).then(r => {
      setAllMems(r.memories);
      const m = new Map<string, number>();
      for (const mem of r.memories) {
        const a = mem.agent.replace(/^import:/, '').replace(/^distill:/, '') || '手工';
        m.set(a, (m.get(a) ?? 0) + 1);
      }
      setAllAgents([...m.entries()].sort((a, b) => b[1] - a[1]));
    }).catch(() => {});
  }, []);

  // 会话索引（cwd→项目映射）：记忆只有项目名，用真实会话路径把目录筛选映射到项目集合
  useEffect(() => {
    void api.listSessions({ limit: 500 }).then(r => setSessions(r.sessions)).catch(() => {});
  }, []);

  // 月份分布（时间筛选 chips；有效时间=origin_ts ?? created_at）
  const monthSource = allMems;
  const monthChips = useMemo<[string, number][]>(() => {
    const m = new Map<string, number>();
    for (const mem of monthSource) {
      const ts = (mem.origin_ts && mem.origin_ts > 0 ? mem.origin_ts : mem.created_at) ?? 0;
      if (!ts) continue;
      const d = new Date(ts * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [monthSource]);

  // 路径 → 其下有会话的项目集合；记忆按项目 ∈ 集合过滤
  const projectsUnder = useCallback((dir: string) => {
    const out = new Set<string>();
    for (const s of sessions) {
      if (s.project && underPath(s.cwd, dir)) out.add(s.project);
    }
    return out;
  }, [sessions]);
  const dirCountUnder = useCallback((p: string) => {
    const set = projectsUnder(p);
    let n = 0;
    for (const proj of set) n += stats?.byProject[proj] ?? 0;
    return n;
  }, [projectsUnder, stats]);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, r] = await Promise.all([
        api.stats(),
        api.listMemories({
          type: filterType || undefined,
          project: filterProject || undefined,
          ...(filterAgent !== '' ? { agent: filterAgent } : {}),
          // 目录筛选是"路径下所有项目"的集合，服务端只收单项目 → 拉大窗口客户端过滤分页
          ...(filterDir !== '' ? { limit: 500 } : { limit: PAGE, offset: (page - 1) * PAGE }),
        }),
      ]);
      setStats(s);
      if (filterDir !== '') {
        const set = projectsUnder(filterDir);
        const filtered = r.memories.filter(m => set.has(m.project));
        setMemories(filtered.slice((page - 1) * PAGE, page * PAGE));
        setTotal(filtered.length);
      } else {
        setMemories(r.memories);
        setTotal(r.total);
      }
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, [filterType, filterProject, filterAgent, filterDir, filterMonth, page, projectsUnder]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (showValue && valueReport === null) {
      void api.memoryValue().then(setValueReport).catch(() => {});
    }
  }, [showValue, valueReport]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE));

  // group by project
  const groups: Record<string, MemoryRecord[]> = {};
  for (const m of memories) (groups[m.project] ??= []).push(m);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}><GradientText>{t('memories.title')}</GradientText></h2>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={reload} disabled={loading} title="刷新">
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
        <button className="btn primary" onClick={() => setShowNew(s => !s)}>
          {showNew ? <><X size={14} /> 取消</> : <><Plus size={14} /> {t('memories.new')}</>}
        </button>
      </div>

      {stats && (
        <div className="stat-line" style={{ display: 'flex', alignItems: 'center' }}>
          <b>{stats.total}</b> {t('memories.total')}
          <i>·</i>
          <b>{Object.keys(stats.byProject).length}</b> {t('memories.projects')}
          <i>·</i>
          <b>{Object.keys(stats.byType).length}</b> {t('memories.types')}
          <i>·</i>
          <span>{stats.total > 0 ? '✓' : '—'} {t('memories.writable')}</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" style={{ fontSize: 12, padding: '2px 10px' }}
            onClick={() => setShowValue(!showValue)}>
            <BarChart3 size={13} style={{ verticalAlign: -1, marginRight: 4 }} />
            价值 {showValue ? '▲' : '▼'}
          </button>
          <button className="btn ghost" style={{ fontSize: 12, padding: '2px 10px', marginLeft: 6 }}
            onClick={() => { setShowImport(true); setImportPreview(null); }}>
            <Upload size={13} style={{ verticalAlign: -1, marginRight: 4 }} />导入
          </button>
        </div>
      )}

      {/* 记忆价值面板（可折叠）：被召回最多的 + 从未召回的退役候选 */}
      {showValue && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
          {valueReport === null ? (
            <div className="meta">加载中…</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 12, flexWrap: 'wrap' }}>
                <span>总 <b>{valueReport.total}</b></span>
                <span>被召回过 <b style={{ color: 'var(--s1)' }}>{valueReport.used}</b></span>
                <span>从未召回 <b style={{ color: 'var(--ink-muted)' }}>{valueReport.neverUsed}</b></span>
                <span>退役候选（＞30天未用）<b style={{ color: 'var(--s3)' }}>{valueReport.retireCandidates.length}</b></span>
              </div>
              {valueReport.topUsed.length > 0 && (
                <>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                    <TrendingUp size={13} style={{ verticalAlign: -1, marginRight: 4, color: 'var(--s1)' }} />
                    被召回最多（强度 = 被验证次数）
                  </div>
                  {valueReport.topUsed.slice(0, 8).map(m => (
                    <div key={m.id} className="pick-item" style={{ marginBottom: 3, cursor: 'pointer' }} onClick={() => openDetail(m.id)}>
                      <span className="chip" data-color={m.type} style={{ flex: 'none' }}>{m.type}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                        {m.text}
                      </span>
                      <span className="meta" style={{ fontSize: 11, flex: 'none' }}>×{m.strength} · {m.project}</span>
                    </div>
                  ))}
                </>
              )}
              {valueReport.retireCandidates.length > 0 && (
                <>
                  <div style={{ fontWeight: 700, fontSize: 13, marginTop: 10, marginBottom: 6, color: 'var(--s3)' }}>
                    退役候选（从未被召回 + 超过 30 天）
                  </div>
                  {valueReport.retireCandidates.slice(0, 5).map(m => (
                    <div key={m.id} className="pick-item" style={{ marginBottom: 3, cursor: 'pointer' }} onClick={() => openDetail(m.id)}>
                      <span className="chip" data-color={m.type} style={{ flex: 'none' }}>{m.type}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                        {m.text}
                      </span>
                      <span className="meta" style={{ fontSize: 11, flex: 'none' }}>{m.ageDays} 天</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* 竞品迁移导入弹窗 */}
      {showImport && (
        <div className="card" style={{ padding: '14px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>导入记忆（Mem0 / hippo-memory / MIF / 任意 JSONL）</div>
          <div className="meta" style={{ fontSize: 12, marginBottom: 8 }}>
            粘贴 JSON Array、JSONL（每行一条）或 {`{"memories":[...]}`} 格式。自动识别字段（text/content/body + type/project）。
          </div>
          <textarea value={importRaw} onChange={e => { setImportRaw(e.target.value); setImportPreview(null); }}
            placeholder='[{"text":"决定用 pnpm","type":"decision","project":"my-app"}]'
            style={{ width: '100%', minHeight: 100, fontSize: 12, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={importBusy || importRaw.trim() === ''}
              onClick={async () => {
                setImportBusy(true);
                try {
                  const r = await fetch('/api/memories/import', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ raw: importRaw }),
                  });
                  setImportPreview(await r.json());
                } catch (e) { console.error(e); }
                setImportBusy(false);
              }}>预览</button>
            {importPreview?.candidates && (
              <button className="btn primary" disabled={importBusy}
                onClick={async () => {
                  setImportBusy(true);
                  try {
                    const r = await fetch('/api/memories/import', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ raw: importRaw, apply: true }),
                    });
                    const d = await r.json();
                    alert(`导入完成：新建 ${d.created} · 强化 ${d.reinforced} · 跳过 ${d.skipped}`);
                    setShowImport(false); reload();
                  } catch (e) { console.error(e); }
                  setImportBusy(false);
                }}>确认导入</button>
            )}
            <button className="btn" onClick={() => setShowImport(false)}>取消</button>
          </div>
          {importPreview?.preview && (
            <div className="meta" style={{ fontSize: 12, marginTop: 8 }}>
              识别 {importPreview.preview.recognized} / {importPreview.preview.total} 条
              {importPreview.preview.skipped > 0 && ` · 跳过 ${importPreview.preview.skipped} 条（无正文字段）`}
              {importPreview.candidates && importPreview.candidates.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {importPreview.candidates.slice(0, 5).map((c, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                      [{c.type}] {c.text.slice(0, 60)}… → {c.project}
                    </div>
                  ))}
                  {importPreview.preview.recognized > 5 && <div style={{ fontSize: 11 }}>…共 {importPreview.preview.recognized} 条</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 筛选：AGENT → 项目 → 类型（与其他页统一的 filter-bar 结构） */}
      <div className="filter-bar">
        <div className="filter-row">
          <span className="fgroup">AGENT</span>
          <div className="chips fchips">
            <button className={`fchip${filterAgent === '' ? ' on' : ''}`}
              onClick={() => { setFilterAgent(''); setPage(1); }}>全部</button>
            {allAgents.map(([a, n]) => (
              <button key={a} className={`fchip${filterAgent === a ? ' on' : ''}`}
                onClick={() => { setFilterAgent(filterAgent === a ? '' : a); setPage(1); }}>
                <AgentIcon agent={a} size={13} /> {agentLabel(a)} <span className="fn">{n}</span>
              </button>
            ))}
            {/* 浏览文件系统选目录（按路径下的项目过滤记忆） */}
            <FolderPicker
              variant="button"
              value={filterDir}
              onChange={(p) => { setFilterDir(p); setFilterProject(''); setPage(1); }}
              counts={dirCountUnder}
              label="浏览"
              title="浏览文件夹，按所选目录下的项目筛记忆"
            />
            {(filterAgent !== '' || filterProject !== '' || filterType !== '' || filterDir !== '' || filterMonth !== '') && (
              <button className="fs-clearall"
                onClick={() => { setFilterAgent(''); setFilterProject(''); setFilterType(''); setFilterDir(''); setFilterMonth(''); setPage(1); }}>
                清除筛选
              </button>
            )}
          </div>
        </div>

        {stats && Object.keys(stats.byProject).length > 0 && (
          <div className="filter-row">
            <span className="fgroup">项目</span>
            <div className="chips fchips">
              <button className={`fchip${filterProject === '' ? ' on' : ''}`}
                onClick={() => { setFilterProject(''); setPage(1); }}>全部</button>
              {Object.entries(stats.byProject).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => (
                <button key={p} className={`fchip${filterProject === p ? ' on' : ''}`}
                  onClick={() => { setFilterProject(filterProject === p ? '' : p); setFilterDir(''); setPage(1); }}>
                  {p} <span className="fn">{n}</span>
                </button>
              ))}
              {filterDir !== '' && (
                <button className="fchip on" style={{ maxWidth: 300 }} title={filterDir}
                  onClick={() => { setFilterDir(''); setPage(1); }}>
                  <FolderOpen size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filterDir}</span> ✕
                </button>
              )}
            </div>
          </div>
        )}

        {monthChips.length > 1 && (
          <div className="filter-row">
            <span className="fgroup">时间</span>
            <div className="chips fchips">
              <button className={`fchip${filterMonth === '' ? ' on' : ''}`}
                onClick={() => { setFilterMonth(''); setPage(1); }}>全部</button>
              {monthChips.slice(0, 12).map(([mo, n]) => (
                <button key={mo} className={`fchip${filterMonth === mo ? ' on' : ''}`}
                  onClick={() => { setFilterMonth(filterMonth === mo ? '' : mo); setPage(1); }}>
                  {mo.replace('-', '年')}月 <span className="fn">{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="filter-row">
          <span className="fgroup">类型</span>
          <div className="chips fchips">
            <button className={`fchip${filterType === '' ? ' on' : ''}`}
              onClick={() => { setFilterType(''); setPage(1); }}>全部</button>
            {MEMORY_TYPES.map(ty => (
              <button key={ty} className={`fchip${filterType === ty ? ' on' : ''}`}
                onClick={() => { setFilterType(filterType === ty ? '' : ty); setPage(1); }}>
                {t(`type.${ty}`)} {stats?.byType[ty] !== undefined && <span className="fn">{stats.byType[ty]}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showNew && <NewMemory onCreated={() => { setShowNew(false); reload(); }} />}

      {memories.length === 0 && !loading ? (
        <EmptyState icon={Brain} title="没有匹配的记忆" hint="试试放宽筛选（项目/类型/时间），或者用「+ 新建」手动添加一条。" />
      ) : (
        Object.keys(groups).sort().map((proj, idx) => (
          <FadeIn key={proj} delay={idx * 0.08}>
            <div className="group">
              <h3>{proj} · {groups[proj].length}</h3>
              <div className="cards">
                {groups[proj].map(m => (
                  <MemoryCard key={m.id} mem={m} onChanged={reload} />
                ))}
              </div>
            </div>
          </FadeIn>
        ))
      )}

      <Pagination page={page} pageCount={pageCount} total={total} onChange={setPage} />
    </div>
  );
}

function NewMemory({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [type, setType] = useState<MemoryType>('fact');
  const [project, setProject] = useState('global');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      await api.createMemory(text, { type, project });
      setText(''); onCreated();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <textarea value={text} onChange={e => setText(e.target.value)} placeholder={t('memories.placeholderText')} />
      <div className="row">
        <select value={type} onChange={e => setType(e.target.value as MemoryType)}>
          {MEMORY_TYPES.map(ty => <option key={ty} value={ty}>{t(`type.${ty}`)}</option>)}
        </select>
        <input type="text" value={project} onChange={e => setProject(e.target.value)} placeholder={t('memories.filterProject')} style={{ width: 160 }} />
        <button className="primary" onClick={submit} disabled={busy || !text.trim()}>{busy ? `${t('common.save')}…` : t('memories.remember')}</button>
        {err && <span className="muted" style={{ color: 'var(--danger)' }}>{err}</span>}
      </div>
    </div>
  );
}

function MemoryCard({ mem, onChanged }: { mem: MemoryRecord; onChanged: () => void }) {
  const { t } = useTranslation();
  const { openDetail } = useDetail();
  const navigate = useNavigate();

  const openSource = async () => {
    try {
      const r = await api.sourceSession(mem.id);
      if (r.sessionId) navigate(`/sessions?focus=${encodeURIComponent(r.sessionId)}`);
      else flash('没有对应的来源会话（可能是手工创建的记忆）');
    } catch { flash('查询来源会话失败'); }
  };
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(mem.text);
  const [type, setType] = useState(mem.type);
  const [project, setProject] = useState(mem.project);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState('');

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 1800); };

  const save = async () => {
    setBusy(true);
    try {
      await api.updateMemory(mem.id, { text, type, project });
      setEditing(false); onChanged(); flash(t('memories.saved'));
    } catch { /* ignore */ }
    setBusy(false);
  };

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    try { await api.deleteMemory(mem.id); onChanged(); flash(t('memories.forgotten')); } catch { /* ignore */ }
    setBusy(false);
  };

  if (editing) {
    return (
      <div className="card" data-type={mem.type}>
        <textarea value={text} onChange={e => setText(e.target.value)} />
        <div className="row">
          <select value={type} onChange={e => setType(e.target.value as MemoryType)}>
            {MEMORY_TYPES.map(ty => <option key={ty} value={ty}>{t(`type.${ty}`)}</option>)}
          </select>
          <input type="text" value={project} onChange={e => setProject(e.target.value)} style={{ width: 160 }} />
          <button className="primary small" onClick={save} disabled={busy}>{t('common.save')}</button>
          <button className="small" onClick={() => setEditing(false)} disabled={busy}>{t('common.cancel')}</button>
        </div>
      </div>
    );
  }

  return (
    <SpotlightCard className="card" data-type={mem.type} style={{ cursor: 'pointer', ...(mem.superseded_by ? { opacity: 0.55 } : {}) }} onClick={() => openDetail(mem.id)}>
      <div className="text">{mem.text}</div>
      <div className="meta">
        <span className="type">{t(`type.${mem.type}`)}</span>
        {mem.superseded_by && <span className="chip" data-color="lesson" title="已被更新版取代，点开看演化链">⚑ 已取代</span>}
        {mem.agent && <span className="mem-agent" title={mem.agent}><AgentIcon agent={mem.agent} size={13} /> {agentLabel(mem.agent)}</span>}
        <span className="strength">{t('memories.str')} {mem.strength.toFixed(2)}</span>
        <span>{toDateStr(mem.created_at)}</span>
        {mem.accessed_at !== mem.created_at && <span>{t('memories.accessed', { date: toDateStr(mem.accessed_at) })}</span>}
        <span className="muted" title={mem.id}>{mem.id.slice(0, 8)}</span>
      </div>
      <div className="actions">
        <button className="small" title="打开来源会话" onClick={e => { e.stopPropagation(); openSource(); }}><MessagesSquare size={13} style={{ verticalAlign: -2 }} /> {t('sessions.title', '会话')}</button>
        <button className="small" onClick={e => { e.stopPropagation(); setEditing(true); }}>{t('common.edit')}</button>
        <button className="small danger" onClick={e => { e.stopPropagation(); setConfirming(true); }} disabled={busy}>{t('memories.forget')}</button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t('memories.forgetConfirmTitle')}
          message={t('memories.forgetConfirm', { text: mem.text.slice(0, 50) })}
          confirmLabel={t('memories.forget')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </SpotlightCard>
  );
}
