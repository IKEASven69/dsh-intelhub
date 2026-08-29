/**
 * 团队记忆页（T2，照 docs/team-memory-mockup.html 效果图）：
 * 统计块 + 晋升队列（证据链→审批三动作）+ 退役三级分流 + 两层混合记忆列表。
 * 数据源：引擎 /api/team/*（triage/entries/promotion/retire）。
 */
import EmptyState from '../components/EmptyState';
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, RefreshCw, Trash2, Users } from 'lucide-react';
import FadeIn from '../components/anim/FadeIn';
import { api, type TeamTriage, type TeamEntries } from '../api';

type Triage = TeamTriage;

const TYPE_COLORS: Record<string, string> = {
  chitchat: 'var(--s-muted, #6b7280)', fact: '#2dd4bf', decision: 'var(--s2)', constraint: '#a78bfa', requirement: 'var(--s3)',
};
const TYPE_LABEL: Record<string, string> = { chitchat: '闲聊', fact: '事实', decision: '决策', constraint: '约束', requirement: '需求' };
const TIER_LABEL: Record<string, string> = { auto: '自动退役', approval: '审批队列', evidence: '证据提案' };

export default function TeamPage() {
  const { t } = useTranslation();
  const [tri, setTri] = useState<Triage | null>(null);
  const [entries, setEntries] = useState<TeamEntries["entries"]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [toast, setToast] = useState('');

  const reload = useCallback(async () => {
    try {
      const [tv, ev] = await Promise.all([api.teamTriage(), api.teamEntries()]);
      setTri(tv); setEntries(ev.entries); setError('');
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2500); };

  const doPromotion = async (id: string, action: 'promoted' | 'ignored' | 'kept-private') => {
    setBusy(true);
    try {
      const r = await api.teamPromotion(id, action, action === 'promoted' ? (editing?.id === id ? editing.text : undefined) : undefined);
      if (!r.ok) flash(r.error ?? '处理失败'); else flash(action === 'promoted' ? '已晋升入团队层' : action === 'ignored' ? '已忽略' : '保持私有');
      setEditing(null); await reload();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const doRetire = async (id: string, action: 'retire' | 'keep') => {
    setBusy(true);
    try {
      const r = await api.teamRetire(id, action);
      if (!r.ok) flash(r.error ?? '处理失败'); else flash(action === 'retire' ? '已退役（可审计恢复）' : '已入白名单保留');
      await reload();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const doScan = async () => {
    setBusy(true);
    try { const r = await api.teamScan(); flash(r.note ?? `扫描完成：${r.teams} 支团队`); await reload(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const teamScope = (s: string) => s.split(':').length < 3 && s.startsWith('team:');

  return (
    <FadeIn>
      <div className="h-row" style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h1><Users size={22} style={{ verticalAlign: -4, marginRight: 8 }} />{t('team.title')}</h1>
        <span className="meta">{tri ? `团队 ${tri.stats.team} · 私有 ${tri.stats.private} · 已退役 ${tri.stats.retired}` : '…'}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={doScan} disabled={busy}><RefreshCw size={14} style={{ verticalAlign: -2, marginRight: 4 }} className={busy ? 'spin' : ''} />扫描蒸馏</button>
        <a className="btn ghost" href="/api/team/export" download>📦 导出 MD 投影</a>
        <button className="btn pri" disabled={busy || !tri} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.teamCycle(tri!.promotions.length >= 0 ? (entries.find(e => e.scope.split(':').length < 3)?.scope.split(':')[1] ?? entries[0]?.scope.split(':')[1] ?? '') : '');
            flash(r.forecastCards ? `周期完成：衰减 ${r.decayed.length} · 预判卡 ${r.forecastCards.length}` : '周期完成');
            await reload();
          } catch (e) { setError((e as Error).message); }
          setBusy(false);
        }}>✦ 运行周期</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {toast && <div className="card" style={{ borderColor: 'var(--s1)', background: 'var(--bg2)', marginBottom: 12 }}>{toast}</div>}

      {tri && (
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))' }}>
          <div className="tile"><b>{tri.stats.team}</b><span>团队记忆（L2）</span></div>
          <div className="tile"><b>{tri.stats.private}</b><span>成员私有（L1）</span></div>
          <div className="tile"><b>{tri.promotions.length}</b><span>待晋升（互证 ≥2）</span></div>
          <div className="tile"><b>{tri.retirements.length}</b><span>待退役（三级分流）</span></div>
        </div>
      )}

      {tri && tri.promotions.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}><ArrowUpCircle size={17} />{t('team.promotions')} <span className="count-pill">跨成员互证 → 审批晋升</span></h2>
          {tri.promotions.map(p => (
            <div key={p.id} className="card" style={{ margin: '10px 0', background: 'var(--bg2)', borderColor: 'rgba(124,92,255,.35)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="team-badge">候选</span>
                <span className="tchip" style={{ background: TYPE_COLORS[p.type] }}>{TYPE_LABEL[p.type] ?? p.type}</span>
                <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.text}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '8px 0' }}>
                {p.evidence.map((e, i) => (
                  <div key={i} className="meta" style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                    <span className="ev-who">{e.member || '?'}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.text}</span>
                    {i > 0 && <span style={{ color: 'var(--s1)' }}>互证 {e.sim.toFixed(2)}</span>}
                  </div>
                ))}
              </div>
              {editing?.id === p.id && (
                <textarea value={editing.text} onChange={e => setEditing({ id: p.id, text: e.target.value })} rows={2} style={{ width: '100%' }} />
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn ok" disabled={busy} onClick={() => doPromotion(p.id, 'promoted')}>✓ 批准晋升</button>
                <button className="btn" disabled={busy} onClick={() => setEditing(editing?.id === p.id ? null : { id: p.id, text: p.text })}>✎ 编辑合并文本</button>
                <button className="btn warn" disabled={busy} onClick={() => doPromotion(p.id, 'kept-private')}>两条各自保留</button>
                <span style={{ flex: 1 }} />
                <button className="btn" disabled={busy} onClick={() => doPromotion(p.id, 'ignored')}>忽略本轮</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {tri && tri.retirements.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}><Trash2 size={17} />{t('team.retirements')} <span className="count-pill">三级分流</span></h2>
          {tri.retirements.slice(0, 8).map(r => (
            <div key={r.entryId} className={`card${r.tier === 'evidence' ? ' ret-evidence' : ''}`} style={{ margin: '8px 0', borderColor: r.tier === 'auto' ? 'var(--border)' : r.tier === 'approval' ? 'rgba(240,161,60,.4)' : 'rgba(240,85,76,.4)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="retire-tag" data-tier={r.tier}>{TIER_LABEL[r.tier]}</span>
                <span className="tchip" style={{ background: TYPE_COLORS[r.type] }}>{TYPE_LABEL[r.type] ?? r.type}</span>
                <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.text}</span>
              </div>
              <div className="meta" style={{ fontSize: 11.5, margin: '6px 0' }}>{r.reason} · {r.ageDays} 天 · 强度 ×{r.strength}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ok" disabled={busy} onClick={() => doRetire(r.entryId, 'retire')}>✓ {r.tier === 'auto' ? '确认退役' : '批准退役'}</button>
                {r.tier === 'approval' && <button className="btn pri" disabled={busy} onClick={() => doRetire(r.entryId, 'keep')}>保留（进白名单）</button>}
              </div>
            </div>
          ))}
        </section>
      )}

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>{t('team.entries')} <span className="count-pill">{entries.length} 条 · 两层混合</span></h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxHeight: 420, overflow: 'auto' }}>
          {entries.slice(0, 60).map(e => (
            <div key={e.id} className="card" style={{ padding: '10px 14px', opacity: teamScope(e.scope) ? 1 : 0.75 }}>
              <div style={{ fontSize: 13, lineHeight: 1.55 }}>{e.text}</div>
              <div className="meta" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className={`scope-tag ${teamScope(e.scope) ? 'scope-team' : 'scope-priv'}`}>{teamScope(e.scope) ? '团队' : `私有 · ${e.scope.split(':').pop()}`}</span>
                <span className="tchip" style={{ background: TYPE_COLORS[e.type] }}>{TYPE_LABEL[e.type] ?? e.type}</span>
                <span>强度 ×{e.strength}</span>
                <span>{new Date(e.createdAt).toLocaleDateString('zh-CN')}</span>
                {e.promotedFrom && e.promotedFrom.length > 0 && (
                  <span className="src-chain">来源链：{e.promotedFrom.slice(0, 3).map((s, i) => <span key={i} className="src-pill">{s.slice(0, 8)}</span>)}</span>
                )}
              </div>
            </div>
          ))}
          {entries.length === 0 && <EmptyState icon={Users} title='暂无团队记忆' hint='跑一次 dsh 团队任务后，子代理的产出会自动进入团队记忆。点「扫描蒸馏」手动触发。' />}
        </div>
      </section>
    </FadeIn>
  );
}
