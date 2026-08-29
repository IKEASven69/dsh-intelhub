/**
 * 会话页（G2）：四动作的主视图——看会话 / 提取会话（导出）/ 提取记忆（蒸馏）。
 * 左侧 agent+项目过滤，中间会话列表（已蒸馏徽标），右侧详情抽屉
 * （Turn 流渲染：user/assistant 着色、tool 失败标红）+ 蒸馏预览确认。
 * URL ?focus=<id> 支持从记忆页跳入并直接打开某会话。
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, RefreshCw, Search, TerminalSquare, Download, FileJson, FileText, FlaskConical, Trash2 } from 'lucide-react';
import { api, workspaceOf, type SessionListItem, type SessionDetail, type SessionDistillPreview, type SyncStatus } from '../api';
import { AgentIcon, agentLabel } from '../components/AgentIcon';
import FolderPicker, { underPath } from '../components/FolderPicker';
import Pagination from '../components/Pagination';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useDetail } from '../components/DetailDrawer';
import type { MemoryRecord } from '../api';
import FadeIn from '../components/anim/FadeIn';

/** ms epoch → YYYY-MM（时间筛选用） */
function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function syncAgo(s: SyncStatus | null): string {
  if (!s?.lastSyncAt) return '';
  return fmtTime(s.lastSyncAt);
}

export default function SessionsPage() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [agent, setAgent] = useState('');
  const [ws, setWs] = useState('');
  const [project, setProject] = useState('');
  const [month, setMonth] = useState('');
  const [q, setQ] = useState('');
  const [searchHits, setSearchHits] = useState<SessionListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 30;

  // 全量拉一次，agent/工作区/项目三级都在客户端级联过滤（列表 <=500，毫秒级）
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await api.listSessions({ limit: 500 });
      setSessions(r.sessions); setTotal(r.total);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, []);

  const loadStatus = useCallback(() => { api.sessionStatus().then(setStatus).catch(() => {}); }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 60_000);
    return () => { clearInterval(timer); };
  }, [loadStatus]);

  // 从记忆页跳入：?focus=<id>
  useEffect(() => {
    const focus = new URLSearchParams(location.search).get('focus');
    if (focus) setOpenId(focus);
  }, []);

  const agents = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) m.set(s.agent, (m.get(s.agent) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessions]);

  // 工作区（cwd 根目录）→ 数量；选定工作区后其下项目才展示（级联，不一次全摊开）
  const workspaces = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      const w = workspaceOf(s.cwd) || '（无路径）';
      m.set(w, (m.get(w) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessions]);

  const projects = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      if (agent !== '' && s.agent !== agent) continue;
      if (ws !== '' && (ws === '（无路径）' ? !!s.cwd : !underPath(s.cwd, ws))) continue;
      m.set(s.project, (m.get(s.project) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessions, ws, agent]);

  const monthChips = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) m.set(monthOf(s.updatedAt), (m.get(monthOf(s.updatedAt)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [sessions]);

  const filtered = useMemo(() => sessions.filter((s) =>
    (agent === '' || s.agent === agent)
    && (ws === '' || (ws === '（无路径）' ? !s.cwd : underPath(s.cwd, ws)))
    && (project === '' || s.project === project)
    && (month === '' || monthOf(s.updatedAt) === month)
  ), [sessions, agent, ws, project, month]);

  // 浏览文件夹时显示每个目录下的会话数（徽标），浏览整盘也知道去哪找
  const countUnder = useCallback((p: string) =>
    sessions.reduce((n, s) => n + (underPath(s.cwd, p) ? 1 : 0), 0), [sessions]);

  const shown = searchHits ?? filtered;

  // 筛选/搜索变化时回到第 1 页，避免停留在超出范围的空页
  useEffect(() => { setPage(1); }, [agent, ws, project, month, searchHits]);

  const doSearch = async () => {
    if (q.trim() === '') { setSearchHits(null); return; }
    setLoading(true); setError('');
    try {
      const hits = await api.searchSessions(q.trim());
      const byId = new Map(sessions.map((s) => [s.id, s]));
      setSearchHits(hits.map((h) => byId.get(h.id)).filter((x): x is SessionListItem => x !== undefined));
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  const doSync = async () => {
    try { setStatus(await api.syncSessions()); reload(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <FadeIn>
      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h1><Search size={22} style={{ verticalAlign: -4, marginRight: 8 }} />{t('nav.sessions')}</h1>
        <span className="meta">
          {searchHits ? `搜索 ${shown.length} / ${total}` : `${filtered.length} / ${total} 个会话`}
          {status?.synced && ` · 同步于 ${syncAgo(status)}`}
        </span>
      </div>
      {error && <div className="error">{error}</div>}

      {openId === null && (
      <div className="filter-bar">
        <div className="filter-row">
          <div className="filter-search">
            <Search size={14} className="fs-ico" />
            <input
              placeholder={t('sessions.searchPh')}
              value={q}
              onChange={(e) => { setQ(e.target.value); if (e.target.value === '') setSearchHits(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            />
            {q !== '' && (
              <button className="fs-clear" title="清除搜索" onClick={() => { setQ(''); setSearchHits(null); }}>✕</button>
            )}
          </div>
          {/* 文件夹浏览：走文件系统任意目录（不锁死工作区 chips），选中后按路径前缀筛会话 */}
          <FolderPicker
            variant="button"
            value={ws === '' || ws === '（无路径）' ? '' : ws}
            onChange={(p) => { setWs(p); setProject(''); }}
            counts={countUnder}
            label="浏览"
            title="浏览文件夹，按所选目录筛选会话"
          />
          <button className="btn ghost" onClick={doSync} title="立即增量同步" disabled={loading}>
            <RefreshCw size={14} style={{ verticalAlign: -2, marginRight: 4 }} className={loading ? 'spin' : ''} />同步
          </button>
          {(agent !== '' || ws !== '' || project !== '' || month !== '' || q !== '') && (
            <button className="fs-clearall" onClick={() => { setAgent(''); setWs(''); setProject(''); setMonth(''); setQ(''); setSearchHits(null); }}>
              清除筛选
            </button>
          )}
        </div>
        {monthChips.length > 1 && (
          <div className="filter-row">
            <span className="fgroup">时间</span>
            <div className="chips fchips">
              <button className={`fchip${month === '' ? ' on' : ''}`} onClick={() => { setMonth(''); setProject(''); }}>全部</button>
              {monthChips.slice(0, 12).map(([mo, n]) => (
                <button key={mo} className={`fchip${month === mo ? ' on' : ''}`} onClick={() => { setMonth(month === mo ? '' : mo); setProject(''); }}>
                  {mo.replace('-', '年')}月 <span className="fn">{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="filter-row">
          <span className="fgroup">AGENT</span>
          <div className="chips fchips">
            <button className={`fchip${agent === '' ? ' on' : ''}`} onClick={() => setAgent('')}>全部</button>
            {agents.map(([a, n]) => (
              <button key={a} className={`fchip${agent === a ? ' on' : ''}`} onClick={() => setAgent(a)}>
                <AgentIcon agent={a} size={14} /> {agentLabel(a)} <span className="fn">{n}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="filter-row">
          <span className="fgroup">工作区</span>
          <div className="chips fchips">
            <button className={`fchip${ws === '' ? ' on' : ''}`} onClick={() => { setWs(''); setProject(''); }}>全部</button>
            {workspaces.map(([w, n]) => (
              <button key={w} className={`fchip${ws === w ? ' on' : ''}`} onClick={() => { setWs(ws === w ? '' : w); setProject(''); }}>
                {w} <span className="fn">{n}</span>
              </button>
            ))}
            {/* 浏览选中的任意路径（不在工作区 chips 里时单独展示，点 ✕ 取消） */}
            {ws !== '' && ws !== '（无路径）' && !workspaces.some(([w]) => w === ws) && (
              <button className="fchip on" style={{ maxWidth: 300 }} title={ws}
                onClick={() => { setWs(''); setProject(''); }}>
                <FolderOpen size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws}</span> ✕
              </button>
            )}
          </div>
        </div>
        {ws !== '' && (
          <div className="filter-row">
            <span className="fgroup">项目</span>
            <div className="chips fchips">
              <button className={`fchip${project === '' ? ' on' : ''}`} onClick={() => setProject('')}>全部</button>
              {projects.map(([p, n]) => (
                <button key={p} className={`fchip${project === p ? ' on' : ''}`} onClick={() => setProject(project === p ? '' : p)}>
                  {p} <span className="fn">{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

      {/* 选中会话时替换为全屏详情；未选时显示列表+分页 */}
      {openId ? (
        <SessionDetailDrawer id={openId} onClose={() => setOpenId(null)} onDistilled={reload} />
      ) : (
        <>
          {/* 当前页按项目分组（与记忆页统一）：组序=最近活跃在前 */}
          {(() => {
            const slice = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
            const byProject: { proj: string; items: SessionListItem[] }[] = [];
            const pi = new Map<string, number>();
            for (const s of slice) {
              const p = s.project || '（无项目）';
              let i = pi.get(p);
              if (i === undefined) { i = byProject.length; pi.set(p, i); byProject.push({ proj: p, items: [] }); }
              byProject[i].items.push(s);
            }
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {byProject.map(g => (
                  <div className="group" key={g.proj} style={{ margin: '6px 0' }}>
                    <h3>{g.proj} · {g.items.length}</h3>
                    <div className="list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {g.items.map((s) => (
                        <SessionRow key={s.id} s={s} active={false} onOpen={() => setOpenId(s.id)} />
                      ))}
                    </div>
                  </div>
                ))}
                {shown.length === 0 && !loading && <div className="meta">{t('sessions.empty')}</div>}
              </div>
            );
          })()}

          <Pagination
            page={page}
            pageCount={Math.max(1, Math.ceil(shown.length / PAGE_SIZE))}
            total={shown.length}
            onChange={setPage}
          />
        </>
      )}
    </FadeIn>
  );
}

function SessionRow({ s, active, onOpen }: { s: SessionListItem; active: boolean; onOpen: () => void }) {
  return (
    <div className={`card clickable${active ? ' active' : ''}`} onClick={onOpen}
      style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <AgentIcon agent={s.agent} size={24} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.title || s.id.slice(0, 24)}
        </div>
        <div className="meta" style={{ fontSize: 13, marginTop: 2 }}>
          {agentLabel(s.agent)} · {s.project || '—'} · {fmtTime(s.updatedAt)}
          {s.turnCount !== null && ` · ${s.turnCount} 轮`}
        </div>
      </div>
      {s.distilled > 0 && (
        <span className="chip" data-color="fact" title="已蒸馏记忆数" style={{ flex: 'none' }}>✦ {s.distilled}</span>
      )}
    </div>
  );
}

function SessionDetailDrawer({ id, onClose, onDistilled }: { id: string; onClose: () => void; onDistilled: () => void }) {
  const { t } = useTranslation();
  const { openDetail } = useDetail();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [mems, setMems] = useState<MemoryRecord[] | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<SessionDistillPreview | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [toast, setToast] = useState('');
  const [confirmingDel, setConfirmingDel] = useState(false);
  const [delSource, setDelSource] = useState(false);

  useEffect(() => {
    setDetail(null); setError(''); setPreview(null); setMems(null);
    api.getSession(id).then(setDetail).catch((e) => setError((e as Error).message));
    api.sessionMemories(id).then((r) => setMems(r.memories)).catch(() => setMems([]));
  }, [id]);

  const doDistill = async (apply: boolean) => {
    setDistilling(true); setError('');
    try {
      const r = await api.distillSession(id, apply);
      setPreview(r);
      if (apply) onDistilled();
    } catch (e) { setError((e as Error).message); }
    setDistilling(false);
  };

  return (
    <div className="session-detail-full" style={{ background: 'var(--page, var(--bg))' }}>
      <div className="card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {detail && <AgentIcon agent={detail.session.agent} size={26} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700 }}>{detail?.session.title || '…'}</div>
            {detail && (
              <div className="meta" style={{ fontSize: 12 }}>
                {agentLabel(detail.session.agent)} · {detail.session.project} · {detail.turns.length} 轮
                {detail.distilledCount > 0 && ` · 已蒸馏 ${detail.distilledCount} 条`}
              </div>
            )}
          </div>
          <a className="btn" href={detail ? api.sessionExportUrl(id, 'md') : '#'} download>
            <FileText size={14} style={{ verticalAlign: -2 }} /> md
          </a>
          <a className="btn" href={detail ? api.sessionExportUrl(id, 'json') : '#'} download>
            <FileJson size={14} style={{ verticalAlign: -2 }} /> json
          </a>
          <button
            className="btn"
            disabled={!detail}
            title={detail ? '在终端继续这个会话' : ''}
            onClick={async () => {
              try {
                const r = await api.resumeSession(id);
                setError('');
                setToast(`已在 ${r.via} 拉起：${r.command}`);
                setTimeout(() => setToast(''), 3200);
              } catch (e) { setError((e as Error).message); }
            }}
          >
            <TerminalSquare size={14} style={{ verticalAlign: -2, marginRight: 4 }} />继续
          </button>
          <button className="btn primary" disabled={!detail || distilling} onClick={() => doDistill(false)}>
            <FlaskConical size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            {distilling ? '…' : t('sessions.distill')}
          </button>
          <button className="btn danger" title="从 hippo 删除此会话" onClick={() => { setConfirmingDel(true); setDelSource(false); }}>
            <Trash2 size={14} style={{ verticalAlign: -2, marginRight: 4 }} />删除
          </button>
          <button className="btn ghost" title="强制重跑蒸馏（旧记忆保留，新候选走去重）"
              onClick={async () => {
                try {
                  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/redistill`, { method: 'POST' });
                  const d = await r.json();
                  setToast(`重蒸馏：新建 ${d.created ?? 0} · 强化 ${d.reinforced ?? 0}`);
                  onDistilled();
                } catch (e) { setError((e as Error).message); }
                setTimeout(() => setToast(''), 3000);
              }}
            >
              <RefreshCw size={14} style={{ verticalAlign: -2, marginRight: 4 }} />重蒸馏
            </button>
          <button className="btn" onClick={onClose}>← 返回列表</button>
        </div>
        {error && <div className="error" style={{ marginTop: 4 }}>{error}</div>}
        {toast && <div className="card" style={{ borderColor: 'var(--s1)', background: 'var(--bg2)' }}>{toast}</div>}
        {confirmingDel && (
          <ConfirmDialog
            title="删除会话"
            message={`从 hippo 移除「${detail?.session.title?.slice(0, 30) ?? id.slice(0, 20)}…」？已蒸馏的记忆保留。` + (delSource ? ' 将同时删除源文件（agent 原始历史，不可恢复）！' : '')}
            confirmLabel={delSource ? '连源文件删除' : '删除'}
            cancelLabel="取消"
            danger
            onConfirm={async () => {
              setConfirmingDel(false);
              try {
                const r = await api.deleteSession(id, delSource);
                setToast(r.sourceDeleted ? '已删除（含源文件）' : r.note ?? '已从 hippo 移除（源文件保留）');
                setTimeout(() => setToast(''), 3000);
                onDistilled(); // 刷新列表
                setTimeout(() => onClose(), 600);
              } catch (e) { setError((e as Error).message); }
            }}
            onCancel={() => setConfirmingDel(false)}
          >
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, marginTop: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={delSource} onChange={e => setDelSource(e.target.checked)} />
              同时删除源文件（{detail?.session.agent === 'zcode' || detail?.session.agent === 'pi' ? 'SQLite 类不支持' : 'file 类可用'}）
            </label>
          </ConfirmDialog>
        )}
      </div>

      {preview && (
        <div className="card" style={{ margin: '12px 0', background: 'var(--bg2)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            蒸馏预览：{preview.candidates.length} 条候选
            {preview.apply && ` · 已入库 新建 ${preview.created} / 强化 ${preview.reinforced} / 待复核 ${preview.maybe}`}
          </div>
          {preview.candidates.map((c, i) => (
            <div key={i} className="meta" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <span className="chip" data-color={c.type} style={{ marginRight: 6 }}>{c.type}</span>
                {c.text.slice(0, 120)}
              </div>
            ))}
            {!preview.apply && preview.candidates.length > 0 && (
              <button className="btn primary" style={{ marginTop: 8 }} disabled={distilling} onClick={() => doDistill(true)}>
                <Download size={14} style={{ verticalAlign: -2, marginRight: 4 }} />确认入库
              </button>
            )}
          </div>
        )}

        {mems !== null && mems.length > 0 && (
          <div className="card" style={{ margin: '12px 0', background: 'var(--bg2)' }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>✦ 本会话蒸馏出的 {mems.length} 条记忆（点击看详情）</div>
            {mems.slice(0, 12).map((m) => (
              <div key={m.id} className="pick-item" style={{ marginBottom: 4 }} onClick={() => openDetail(m.id)}>
                <span className="chip" data-color={m.type} style={{ flex: 'none' }}>{m.type}</span>
                <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.text}</span>
              </div>
            ))}
            {mems.length > 12 && <div className="meta">…共 {mems.length} 条</div>}
          </div>
        )}

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}>
          {(detail?.turns ?? []).slice(0, 400).map((turn, i) => (
            <TurnRow key={i} turn={turn} agent={detail?.session.agent ?? ''} />
          ))}
          {detail && detail.turns.length > 400 && (
            <div className="meta">… 共 {detail.turns.length} 轮，仅显示前 400（导出看全文）</div>
          )}
        </div>
    </div>
  );
}

function TurnRow({ turn, agent }: { turn: { role: string; text: string; toolName?: string; toolFailed?: boolean }; agent: string }) {
  const isUser = turn.role === 'user';
  const isTool = turn.role === 'tool';
  const borderColor = turn.toolFailed ? 'var(--s3)' : isUser ? 'var(--s2)' : isTool ? 'var(--border)' : 'var(--s1)';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '10px 14px', borderRadius: 10,
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${borderColor}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {turn.role === 'assistant' && agent !== '' && <AgentIcon agent={agent} size={16} />}
        <span style={{
          fontSize: 12, fontWeight: 700,
          color: isUser ? 'var(--s2)' : isTool ? 'var(--ink-muted)' : 'var(--s1)',
        }}>
          {turn.role === 'user' ? '用户' : turn.role === 'assistant' ? agentLabel(agent) || '助手' : '工具'}
        </span>
        {turn.toolName && (
          <span style={{ fontSize: 11, color: 'var(--ink-muted)', fontFamily: 'ui-monospace, monospace' }}>
            {turn.toolName}
          </span>
        )}
        {turn.toolFailed && <span style={{ fontSize: 11, color: 'var(--s3)', fontWeight: 700 }}>✕ 失败</span>}
      </div>
      <div style={{
        fontSize: isTool ? 12 : 13.5,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: isTool ? 'var(--ink-2)' : 'var(--ink-1)',
        fontFamily: isTool ? 'ui-monospace, monospace' : 'inherit',
        opacity: isTool ? 0.85 : 1,
      }}>
        {turn.text.slice(0, 600)}
      </div>
    </div>
  );
}
