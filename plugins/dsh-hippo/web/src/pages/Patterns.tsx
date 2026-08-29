import { Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import EmptyState from '../components/EmptyState';
import { api, type PatternDict } from '../api';
import CountUp from '../components/anim/CountUp';
import FadeIn from '../components/anim/FadeIn';
import GradientText from '../components/anim/GradientText';

export default function PatternsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ scanned: number; total: number; patterns: PatternDict[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exportDir, setExportDir] = useState('');
  const [exported, setExported] = useState<string[] | null>(null);

  const reload = async () => {
    setLoading(true); setError('');
    try {
      setData(await api.patterns({ top: 30 }));
      setExported(null);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const doExport = async () => {
    if (!exportDir.trim()) return;
    setLoading(true); setError('');
    try {
      const r = await api.exportSkills(exportDir);
      setExported(r.exported);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  return (
    <div>
      <h2><GradientText>{t('patterns.title')}</GradientText></h2>
      <p className="sub">{t('patterns.subtitle')}</p>

      {data && (
        <div className="tiles">
          <div className="tile"><b><CountUp to={data.scanned} /></b><span>{t('patterns.sessions')}</span></div>
          <div className="tile"><b><CountUp to={data.total} /></b><span>{t('patterns.transcripts')}</span></div>
          <div className="tile"><b><CountUp to={data.patterns.length} /></b><span>{t('patterns.patterns')}</span></div>
          <div className="tile"><b>{data.patterns.length > 0 ? data.patterns[0].score.toFixed(2) : '—'}</b><span>{t('patterns.topScore')}</span></div>
        </div>
      )}

      <div className="toolbar">
        <span className="label">{t('patterns.exportLabel')}</span>
        <input type="text" value={exportDir} onChange={e => setExportDir(e.target.value)}
          placeholder={t('patterns.exportPlaceholder')} style={{ width: 280 }} />
        <button className="primary" onClick={doExport} disabled={loading || !exportDir.trim() || !data?.patterns.length}>
          {loading ? '…' : t('patterns.exportBtn')}
        </button>
        <button onClick={reload} disabled={loading}>{loading ? '…' : t('patterns.rescan')}</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {exported && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="text">{t('patterns.exported', { count: exported.length })}</div>
          <div className="steps">{exported.map(p => '• ' + p).join('\n')}</div>
        </div>
      )}

      {!loading && data?.patterns.length === 0 ? (
        <EmptyState icon={Workflow} title="尚未发现重复工作流" hint="扫描全部 agent 会话的工具调用序列，找出跨会话重复的操作模式（≥2 个会话出现才算）。当前仅扫 Claude Code 转录。" />
      ) : (
        <div className="cards">
          {data?.patterns.map((p, i) => <FadeIn key={i} delay={i * 0.05}><PatternCard p={p} /></FadeIn>)}
        </div>
      )}
    </div>
  );
}

function PatternCard({ p }: { p: PatternDict }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-type="decision">
      <div className="text">{p.steps.join(' → ')}</div>
      <div className="meta">
        <span className="type">{t('patterns.scoreLabel')} {p.score.toFixed(3)}</span>
        <span>{t('patterns.across', { sessions: p.sessions, count: p.count })}</span>
        <span>{t('patterns.success')} {Math.round(p.success_rate * 100)}%</span>
        {p.failures > 0 && <span style={{ color: 'var(--danger)' }}>{p.failures} {t('patterns.failures')}</span>}
      </div>
      {p.examples.length > 0 && (
        <div className="examples">
          {p.examples.slice(0, 2).map((ex, i) => (
            <div key={i}>{ex.map((s, j) => <span key={j}>{j > 0 && ' → '}{s}</span>)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
