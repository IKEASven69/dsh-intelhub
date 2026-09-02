/**
 * 蒸馏页（G2 重构）：主入口=从会话直接蒸馏——搜索选择会话 → 预览候选
 * （可按条勾选）→ 入库；高级区保留粘贴/文件转录（适配任意 jsonl）。
 * 文案随四 agent 现实更新（不再只提 Claude/Codex）。
 */
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Bot, ChevronDown, FlaskConical, FolderOpen, Search, Upload } from 'lucide-react';
import { AgentIcon, agentLabel } from '../components/AgentIcon';
import FolderPicker, { underPath } from '../components/FolderPicker';
import {
  api, type Candidate,
  type SessionListItem, type SessionDistillPreview,
  type AutoDistillSettings, type ShelvedItem,
} from '../api';
import GradientText from '../components/anim/GradientText';
import FadeIn from '../components/anim/FadeIn';

function fmtTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function DistillPage() {
  const { t } = useTranslation();
  // 会话模式（主入口）
  const [sq, setSq] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickList, setPickList] = useState<SessionListItem[]>([]);
  const [chosen, setChosen] = useState<SessionListItem | null>(null);
  // agent / 目录 / 项目过滤（与 sessions 页同构：可浏览文件系统任意目录）
  const [allSessions, setAllSessions] = useState<SessionListItem[]>([]);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterDir, setFilterDir] = useState('');
  const [filterProject, setFilterProject] = useState('');
  // 候选与入库（两种模式共用展示层）
  const [preview, setPreview] = useState<SessionDistillPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ created: number; reinforced: number; skipped: number; maybe: number } | null>(null);
  // 高级：粘贴/文件模式
  const [advanced, setAdvanced] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [project, setProject] = useState('');
  const [pasteCands, setPasteCands] = useState<Candidate[] | null>(null);
  // 待复核 tab + 自动蒸馏（AD-3）
  const [tab, setTab] = useState<'main' | 'review'>('main');
  const [auto, setAuto] = useState<AutoDistillSettings | null>(null);
  const [shelved, setShelved] = useState<ShelvedItem[]>([]);
  const [shelvedSel, setShelvedSel] = useState<Set<number>>(new Set());
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoToast, setAutoToast] = useState('');

  const reloadAuto = useCallback(() => {
    api.autoDistill().then(r => setAuto(r.settings)).catch(() => {});
    api.shelved().then(setShelved).catch(() => setShelved([]));
  }, []);
  useEffect(() => { reloadAuto(); }, [reloadAuto]);

  const saveMode = (patch: Partial<AutoDistillSettings>) => {
    if (!auto) return;
    api.autoDistillSave(patch)
      .then(r => { setAuto(r.settings); setAutoToast('已保存（下一轮扫描生效）'); })
      .catch(e => setAutoToast((e as Error).message));
    setTimeout(() => setAutoToast(''), 2500);
  };

  const runNow = async () => {
    setAutoBusy(true);
    try {
      const r = await api.autoDistillRun();
      setAutoToast(`扫描 ${r.scanned} · 新增 ${r.created} · 强化 ${r.reinforced} · 待审 +${r.shelved}`);
      reloadAuto();
    } catch (e) { setAutoToast((e as Error).message); }
    setAutoBusy(false);
    setTimeout(() => setAutoToast(''), 3500);
  };

  const applyShelved = async (indices: number[]) => {
    setAutoBusy(true);
    try {
      const r = await api.shelvedApply(indices);
      setAutoToast(`入库：新建 ${r.created} · 强化 ${r.reinforced}`);
      setShelvedSel(new Set());
      reloadAuto();
    } catch (e) { setAutoToast((e as Error).message); }
    setAutoBusy(false);
    setTimeout(() => setAutoToast(''), 3000);
  };

  // 页面加载时自动拉全部会话 + 默认展示最近的（用户不点也能看到列表）
  useEffect(() => {
    void api.listSessions({ limit: 500 }).then(r => setAllSessions(r.sessions)).catch(() => {});
  }, []);
  // 过滤 + 默认展示最近 8 条（无需点击"最近会话"）
  useEffect(() => {
    if (chosen !== null) return; // 已选中时不覆盖
    const filtered = allSessions.filter(s =>
      (filterAgent === '' || s.agent === filterAgent) &&
      (filterDir === '' || underPath(s.cwd, filterDir)) &&
      (filterProject === '' || s.project === filterProject)
    );
    setPickList(filtered.slice(0, 8));
  }, [allSessions, filterAgent, filterDir, filterProject, chosen]);

  const agents = [...new Set(allSessions.map(s => s.agent))];
  const projects = [...new Set(allSessions.filter(s =>
    (filterAgent === '' || s.agent === filterAgent) &&
    (filterDir === '' || underPath(s.cwd, filterDir))
  ).map(s => s.project))].slice(0, 10);
  const countUnder = (p: string) => allSessions.reduce((n, s) => n + (underPath(s.cwd, p) ? 1 : 0), 0);

  const loadPickList = async () => {
    setPicking(true); setError('');
    try {
      if (sq.trim() === '') {
        const recent = await api.listSessions({ limit: 10 });
        setPickList(recent.sessions);
      } else {
        const hits = await api.searchSessions(sq.trim());
        const all = await api.listSessions({ limit: 500 });
        const byId = new Map(all.sessions.map((s) => [s.id, s]));
        setPickList(hits.map((h) => byId.get(h.id)).filter((x): x is SessionListItem => x !== undefined).slice(0, 8));
      }
    } catch (e) { setError((e as Error).message); }
    setPicking(false);
  };

  const distillSession = async (apply: boolean) => {
    if (!chosen) return;
    setBusy(true); setError(''); if (apply) setResult(null);
    try {
      const r = await api.distillSession(chosen.id, apply, apply ? [...selected] : undefined);
      setPreview(r);
      if (!apply) {
        const sel = new Set<number>();
        r.candidates.forEach((c, i) => { if (c.duplicate !== 'maybe') sel.add(i); });
        setSelected(sel);
      } else {
        setResult({ created: r.created, reinforced: r.reinforced, skipped: r.skipped, maybe: r.maybe });
      }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  // ── 高级模式（粘贴/文件）──
  const pastePreview = async () => {
    if (!transcript.trim()) return;
    setBusy(true); setError(''); setResult(null); setPasteCands(null); setSelected(new Set());
    try {
      const r = await api.distillPreview(transcript, project || undefined);
      setPasteCands(r.candidates);
      const sel = new Set<number>();
      r.candidates.forEach((c, i) => { if (c.duplicate !== 'reinforce') sel.add(i); });
      setSelected(sel);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const pasteApply = async () => {
    if (!pasteCands) return;
    const chosenCands = [...selected].map(i => pasteCands[i]).filter(Boolean);
    if (chosenCands.length === 0) return;
    setBusy(true); setError('');
    try {
      const r = await api.distillApply(chosenCands, 'distill:web');
      setResult(r);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setTranscript(String(reader.result ?? ''));
    reader.readAsText(f);
  };

  const toggle = (i: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const cands: { text: string; type: string; confidence: number; duplicate: string }[] = useMemo(
    () => preview?.candidates ?? pasteCands ?? [],
    [preview, pasteCands]);

  return (
    <FadeIn>
      <h2><GradientText>{t('distill.title')}</GradientText></h2>
      <p className="sub">{t('distill.subtitle')}</p>

      {/* tab：从会话蒸馏 / 待复核 + 自动蒸馏状态 */}
      <div className="chips fchips" style={{ marginBottom: 10 }}>
        <button className={`fchip${tab === 'main' ? ' on' : ''}`} onClick={() => setTab('main')}>从会话蒸馏</button>
        <button className={`fchip${tab === 'review' ? ' on' : ''}`} onClick={() => { setTab('review'); reloadAuto(); }}>
          待复核 {shelved.length > 0 && <span className="fn">{shelved.length}</span>}
        </button>
        <span style={{ flex: 1 }} />
        {auto && (
          <span className="meta" style={{ fontSize: 12 }}>
            <Bot size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
            自动：{auto.mode === 'off' ? '关' : auto.mode === 'review' ? '全进待审' : '自动入库'}
            {auto.lastRun && ` · 上轮 扫${auto.lastRun.scanned} +${auto.lastRun.created}/~${auto.lastRun.shelved}`}
            <button className="fs-clear" style={{ marginLeft: 8 }} onClick={runNow} disabled={autoBusy}>
              {autoBusy ? '…' : '立即扫描'}
            </button>
          </span>
        )}
      </div>

      {autoToast && <div className="card" style={{ marginBottom: 10, padding: '6px 12px', fontSize: 12.5 }}>{autoToast}</div>}

      {/* ── 待复核 tab：搁置队列（maybe 带候选不再消失，可补入库/丢弃）── */}
      {tab === 'review' && (
        <div className="card" style={{ padding: '14px 16px' }}>
          {auto && (
            <div className="form-row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              <span className="muted">模式</span>
              {([['off', '关闭'], ['review', '全进待审'], ['auto', '自动入库']] as const).map(([m, l]) => (
                <button key={m} className={`fchip${auto.mode === m ? ' on' : ''}`} onClick={() => saveMode({ mode: m })}>{l}</button>
              ))}
              <span className="muted" style={{ marginLeft: 12 }}>置信度 ≥ {auto.threshold.toFixed(2)}</span>
              <input type="range" min={0.5} max={1} step={0.05} value={auto.threshold}
                style={{ width: 110 }} onChange={e => saveMode({ threshold: Number(e.target.value) })} />
              <span className="muted" style={{ marginLeft: 12 }}>间隔 {auto.intervalMin} 分钟</span>
              <input type="range" min={5} max={120} step={5} value={auto.intervalMin}
                style={{ width: 110 }} onChange={e => saveMode({ intervalMin: Number(e.target.value) })} />
            </div>
          )}
          {shelved.length === 0 ? (
            <div className="empty">队列为空——maybe 带候选和低置信候选会出现在这里，不会丢失。</div>
          ) : (
            <>
              <div className="form-row" style={{ marginBottom: 8 }}>
                <button className="btn primary small" disabled={autoBusy || shelvedSel.size === 0}
                  onClick={() => applyShelved([...shelvedSel])}>入库所选（{shelvedSel.size}）</button>
                <button className="btn small" disabled={autoBusy}
                  onClick={() => { void api.shelvedDiscard(shelved.map(x => x.index)).then(reloadAuto); }}>清空队列</button>
              </div>
              {shelved.map(item => (
                <div key={item.index} className="pick-item" style={{ marginBottom: 4 }}>
                  <input type="checkbox" checked={shelvedSel.has(item.index)}
                    onChange={() => setShelvedSel(prev => {
                      const next = new Set(prev);
                      if (next.has(item.index)) next.delete(item.index); else next.add(item.index);
                      return next;
                    })} />
                  <span className="chip" data-color={item.candidate.type} style={{ flex: 'none' }}>{item.candidate.type}</span>
                  <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {item.candidate.text}
                  </span>
                  <span className="meta" style={{ fontSize: 11, flex: 'none' }}>
                    {item.reason} · conf {item.candidate.confidence.toFixed(2)} · {item.candidate.project}
                  </span>
                  {item.suggest && (
                    <span
                      title={item.suggestReason || 'LLM 预审建议'}
                      style={{
                        flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 9,
                        color: item.suggest === 'accept' ? 'var(--success)' : 'var(--warning)',
                        border: `1px solid ${item.suggest === 'accept' ? 'var(--success)' : 'var(--warning)'}`,
                        opacity: 0.85,
                      }}
                    >
                      🦛 建议{item.suggest === 'accept' ? '收' : '弃'}{item.suggestReason ? `·${item.suggestReason.slice(0, 14)}` : ''}
                    </span>
                  )}
                  <button className="fs-clear" title="丢弃" onClick={() => { void api.shelvedDiscard([item.index]).then(reloadAuto); }}>✕</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── 从会话蒸馏（主入口）── */}
      {tab === 'main' && (
      <div className="card" style={{ padding: '14px 16px' }}>
        <div className="form-row">
          <div className="filter-search" style={{ maxWidth: 460 }}>
            <Search size={14} className="fs-ico" />
            <input
              placeholder={t('distill.pickSession')}
              value={sq}
              onChange={(e) => { setSq(e.target.value); if (e.target.value === '') { setChosen(null); } }}
              onKeyDown={(e) => { if (e.key === 'Enter') loadPickList(); }}
            />
          </div>
          <button className="btn ghost" onClick={loadPickList} disabled={picking}>
            {picking ? '…' : (sq.trim() === '' ? t('distill.recent') : t('distill.find'))}
          </button>
          <FolderPicker
            variant="button"
            value={filterDir}
            onChange={(p) => { setFilterDir(p); setFilterProject(''); }}
            counts={countUnder}
            label="浏览"
            title="浏览文件夹，按所选目录筛会话"
          />
          {(filterAgent !== '' || filterDir !== '' || filterProject !== '') && (
            <button className="fs-clearall" onClick={() => { setFilterAgent(''); setFilterDir(''); setFilterProject(''); }}>
              清除筛选
            </button>
          )}
          {chosen && (
            <button className="btn primary" onClick={() => distillSession(false)} disabled={busy}>
              <FlaskConical size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
              {busy ? '…' : t('distill.preview')}
            </button>
          )}
        </div>

        {/* agent + 项目过滤（与 sessions 页同构） */}
        <div className="chips" style={{ marginTop: 10, gap: 5 }}>
          <span className="fgroup">AGENT</span>
          <button className={`fchip${filterAgent === '' ? ' on' : ''}`} onClick={() => setFilterAgent('')}>全部</button>
          {agents.map(a => (
            <button key={a} className={`fchip${filterAgent === a ? ' on' : ''}`} onClick={() => { setFilterAgent(filterAgent === a ? '' : a); setFilterProject(''); }}>
              <AgentIcon agent={a} size={13} /> {agentLabel(a)}
            </button>
          ))}
          {filterDir !== '' && (
            <button className="fchip on" style={{ maxWidth: 300 }} title={filterDir} onClick={() => setFilterDir('')}>
              <FolderOpen size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filterDir}</span> ✕
            </button>
          )}
        </div>
        {filterAgent !== '' && (
          <div className="chips" style={{ marginTop: 6, gap: 5 }}>
            <span className="fgroup">项目</span>
            <button className={`fchip${filterProject === '' ? ' on' : ''}`} onClick={() => setFilterProject('')}>全部</button>
            {projects.map(p => (
              <button key={p} className={`fchip${filterProject === p ? ' on' : ''}`} onClick={() => setFilterProject(filterProject === p ? '' : p)}>
                {p}
              </button>
            ))}
          </div>
        )}

        {pickList.length > 0 && !chosen && (
          <div className="pick-list">
            {pickList.map((s) => (
              <button key={s.id} className="pick-item" onClick={() => { setChosen(s); setPickList([]); }}>
                <AgentIcon agent={s.agent} size={18} />
                <span className="pi-title">{s.title || s.id.slice(0, 24)}</span>
                <span className="meta">{agentLabel(s.agent)} · {s.project} · {fmtTime(s.updatedAt)}{s.turnCount !== null ? ` · ${s.turnCount} 轮` : ''}</span>
              </button>
            ))}
          </div>
        )}
        {chosen && (
          <div className="chosen-session">
            <AgentIcon agent={chosen.agent} size={18} />
            <span style={{ fontWeight: 600 }}>{chosen.title || chosen.id.slice(0, 24)}</span>
            <span className="meta">{agentLabel(chosen.agent)} · {chosen.project}{chosen.turnCount !== null ? ` · ${chosen.turnCount} 轮` : ''}</span>
            <button className="fs-clear" title="换一个" onClick={() => { setChosen(null); setPreview(null); }}>✕</button>
          </div>
        )}
      </div>
      )}

      {/* ── 高级：粘贴/文件 ── */}
      <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}>
        <ChevronDown size={14} style={{ transform: advanced ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
        {t('distill.advanced')}
      </button>
      {advanced && (
        <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea value={transcript} onChange={e => setTranscript(e.target.value)}
            placeholder={t('distill.placeholder')} />
          <div className="form-row">
            <label className="file-btn">
              <Upload size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{t('distill.loadFile')}
              <input type="file" accept=".jsonl,.json,.txt" onChange={onFile} />
            </label>
            <span className="muted">{t('distill.project')}</span>
            <input type="text" value={project} onChange={e => setProject(e.target.value)} placeholder={t('distill.scope')} style={{ width: 160 }} />
            <button className="btn" onClick={pastePreview} disabled={busy || !transcript.trim()}>
              {busy ? '…' : t('distill.preview')}
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {preview && chosen && (
        <div className="card" style={{ margin: '14px 0' }}>
          <div className="text">
            {preview.scannedTurns} 轮解析 · {preview.candidates.length} 条候选 · 已选 {selected.size}
          </div>
          {preview.candidates.length > 0 && (
            <div className="actions">
              <button className="primary small" onClick={() => distillSession(true)} disabled={busy || selected.size === 0}>
                {t('distill.applySelected', { count: selected.size })}
              </button>
            </div>
          )}
        </div>
      )}

      {pasteCands && !chosen && (
        <div className="card" style={{ margin: '14px 0' }}>
          <div className="text">{t('distill.parsedSimple', { count: pasteCands.length, selected: selected.size })}</div>
          <div className="actions">
            <button className="primary small" onClick={pasteApply} disabled={busy || selected.size === 0}>
              {t('distill.applySelected', { count: selected.size })}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ borderColor: 'var(--s3)', marginBottom: 14 }}>
          <div className="text">{t('distill.result', { created: result.created, reinforced: result.reinforced, skipped: result.skipped, maybe: result.maybe })}</div>
        </div>
      )}

      {cands.length === 0 && (preview || pasteCands) && <div className="empty">{t('distill.empty')}</div>}

      {cands.length > 0 && (
        <div className="cards">
          {cands.map((c, i) => (
            <div className="card" data-type={c.type} key={i} style={{ opacity: selected.has(i) ? 1 : 0.5 }}>
              <div className="text">{c.text}</div>
              <div className="meta">
                <span className="type">{t(`type.${c.type}`)}</span>
                <span>{t('distill.conf')} {c.confidence.toFixed(2)}</span>
              </div>
              <div className="actions">
                <label className="pick-label" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} /> {t('distill.apply')}
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="sub" style={{ marginTop: 14 }}><Trans i18nKey="distill.footer" components={{ b: <b /> }} /></p>
    </FadeIn>
  );
}
