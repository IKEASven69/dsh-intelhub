import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { api, type Diagnostics, BASE } from '../api';
import GradientText from '../components/anim/GradientText';

export default function DoctorPage() {
  const { t } = useTranslation();
  const [d, setD] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 睡眠整合（P0-3）
  const [sleepReport, setSleepReport] = useState<{
    dupClusters: unknown[]; merged: number; orphanSources: unknown[];
    orphanSourcesDeleted: number; staleShelvedDropped: number;
  } | null>(null);
  const [sleepApplied, setSleepApplied] = useState(false);
  const [sleepBusy, setSleepBusy] = useState(false);
  // tier 老化归档（H12 M-01）
  const [tierDry, setTierDry] = useState<{ groupsFound: number; groups: Array<{ project: string; month: string; type: string; ids: string[] }> } | null>(null);
  const [tierResult, setTierResult] = useState<{ groupsFound: number; digestsCreated: number; archived: number; llmUsed: boolean } | null>(null);
  const [tierBusy, setTierBusy] = useState(false);

  const runTierDry = async () => {
    setTierBusy(true);
    try { setTierDry(await api.tierAgingDryRun()); } catch (e) { setError((e as Error).message); }
    setTierBusy(false);
  };
  const runTierApply = async () => {
    setTierBusy(true);
    try {
      setTierResult(await api.tierAgingApply());
      setTierDry(null);
      reload();
    } catch (e) { setError((e as Error).message); }
    setTierBusy(false);
  };

  const runSleepDry = async () => {
    setSleepBusy(true); setSleepApplied(false);
    try {
      const r = await fetch(`${BASE}/api/sleep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setSleepReport(await r.json());
    } catch (e) { setError((e as Error).message); }
    setSleepBusy(false);
  };

  const runSleepApply = async () => {
    setSleepBusy(true);
    try {
      const r = await fetch(`${BASE}/api/sleep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"apply":true}' });
      setSleepReport(await r.json());
      setSleepApplied(true);
      reload();
    } catch (e) { setError((e as Error).message); }
    setSleepBusy(false);
  };

  const reload = async () => {
    setLoading(true); setError('');
    try { setD(await api.doctor()); } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  if (!d && !error) return <div className="empty">{t('common.loading')}</div>;

  const healthy = d && d.integrity === 'ok' && !d.dimMismatch && d.orphanVectors === 0 && d.orphanMemories === 0 && d.ftsDrift === 0;
  const issues: string[] = [];
  if (d) {
    if (d.integrity !== 'ok') issues.push(t('doctor.issueIntegrity', { msg: d.integrity }));
    if (d.dimMismatch) issues.push(t('doctor.issueDim', { store: d.vectorDim, provider: d.providerDim }));
    if (d.orphanVectors > 0) issues.push(t('doctor.issueOrphanVec', { count: d.orphanVectors }));
    if (d.orphanMemories > 0) issues.push(t('doctor.issueOrphanMem', { count: d.orphanMemories }));
    if (Math.abs(d.ftsDrift) > 0) issues.push(t('doctor.issueFts', { drift: d.ftsDrift > 0 ? `+${d.ftsDrift}` : String(d.ftsDrift) }));
  }

  return (
    <div>
      <h2><GradientText>{t('doctor.title')}</GradientText></h2>
      <p className="sub">
        <Trans
          i18nKey="doctor.subtitle"
          components={{ 1: <code /> }}
        />
      </p>

      {error && <div className="error-banner">{error}</div>}

      {d && (
        <>
          <div className="tiles">
            <div className="tile"><b>{d.memoryCount}</b><span>{t('doctor.memories')}</span></div>
            <div className="tile"><b>{d.vectorCount}</b><span>{d.vectorDim ? t('doctor.vectors', { dim: `(${d.vectorDim}-d)` }) : t('doctor.vectorsPlain')}</span></div>
            <div className="tile"><b>{d.integrity === 'ok' ? '✓' : '✗'}</b><span>{t('doctor.integrity')}</span></div>
            <div className="tile"><b>{healthy ? '✓' : issues.length}</b><span>{healthy ? t('doctor.healthy') : t('doctor.issues')}</span></div>
          </div>

          {issues.length > 0 && (
            <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: 14 }}>
              <div className="text" style={{ color: 'var(--danger)' }}>{t('doctor.issuesFound')}</div>
              <ul style={{ paddingLeft: 20, marginTop: 6, fontSize: 13 }}>
                {issues.map((iss, i) => <li key={i}>{iss}</li>)}
              </ul>
            </div>
          )}

          <div className="toolbar">
            <button onClick={reload} disabled={loading}>{loading ? '…' : t('doctor.recheck')}</button>
            <button className="danger" disabled title={t('doctor.subtitle')}>{t('doctor.rebuild')}</button>
            <span className="muted">{t('doctor.provider')}: {d.providerDim ?? '?'}-d · ~/.hippo</span>
          </div>

          {/* 睡眠整合（P0-3）：先出报告，确认后 apply */}
          <div className="card" style={{ marginTop: 14, padding: '12px 16px' }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>睡眠整合（记忆库自我维护）</div>
            <div className="meta" style={{ fontSize: 12.5, marginBottom: 8 }}>
              合并近重复记忆（sim≥0.95，强度相加）· 回收孤儿 L0 源（移入 sources.trash，可捞回）· 清 30 天前的过期搁置候选
            </div>
            {sleepReport ? (
              <div className="meta" style={{ fontSize: 12.5 }}>
                近重复簇 <b>{sleepReport.dupClusters.length}</b>
                {' · '}孤儿源 <b>{sleepReport.orphanSources.length}</b>
                {' · '}过期搁置 <b>{sleepReport.staleShelvedDropped}</b>
                {sleepApplied && ` · 已执行：合并 ${sleepReport.merged} · 源入回收站 ${sleepReport.orphanSourcesDeleted}`}
              </div>
            ) : (
              <div className="meta" style={{ fontSize: 12.5 }}>点击「体检」先看报告，不会动任何数据。</div>
            )}
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button onClick={runSleepDry} disabled={sleepBusy}>{sleepBusy ? '…' : '体检（只读报告）'}</button>
              {sleepReport && !sleepApplied && (
                <button className="primary" onClick={runSleepApply} disabled={sleepBusy || (sleepReport.dupClusters.length === 0 && sleepReport.orphanSources.length === 0 && sleepReport.staleShelvedDropped === 0)}>
                  {sleepBusy ? '…' : '执行'}
                </button>
              )}
            </div>
          </div>

          {/* tier 老化归档（H12 M-01）：90 天前 lesson/decision 群卷摘要，原始条目沉底可逆 */}
          <div className="card" style={{ marginTop: 12, padding: '12px 16px' }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>🦛 tier 老化归档（上下文瘦身）</div>
            <div className="meta" style={{ fontSize: 12.5, marginBottom: 8 }}>
              90 天前的教训/决策/事实按 项目+月 分组（≥3 条）卷成一条归档摘要——LLM 压缩（走你配置的模型），原始条目经演化链沉底（recall 降权、可追溯、可逆）
            </div>
            {tierDry ? (
              tierDry.groupsFound === 0 ? (
                <div className="meta" style={{ fontSize: 12.5 }}>没有可归档的分组（不足 3 条同类或都不够老）。</div>
              ) : (
                <div className="meta" style={{ fontSize: 12.5 }}>
                  发现 <b>{tierDry.groupsFound}</b> 组：
                  {tierDry.groups.map(g => (
                    <div key={g.project + g.month + g.type} style={{ marginLeft: 10 }}>
                      · {g.project} {g.month} [{g.type}] {g.ids.length} 条
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div className="meta" style={{ fontSize: 12.5 }}>点击「体检」先看 dry-run 报告，不会动任何数据。</div>
            )}
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button onClick={runTierDry} disabled={tierBusy}>{tierBusy ? '…' : '体检（只读报告）'}</button>
              {tierDry && tierDry.groupsFound > 0 && (
                <button className="primary" onClick={runTierApply} disabled={tierBusy}>
                  {tierBusy ? '归档中…' : `执行归档（LLM 压缩）`}
                </button>
              )}
              {tierResult && (
                <span className="meta" style={{ fontSize: 12.5 }}>
                  ✅ {tierResult.groupsFound} 组 → 摘要 {tierResult.digestsCreated} · 沉底 {tierResult.archived} 条{tierResult.llmUsed ? ' · LLM 压缩' : ' · 规则拼接降级'}
                </span>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
