/**
 * 召回页：记忆库语义搜索。优化（P1）：
 * - 空状态引导：可点的示例查询（通用 + 按热门项目动态生成）
 * - 搜索历史（localStorage，最近 8 条，可一键清空）
 * - 项目筛选统一为 chips（替代裸文本框）
 * - 结果带类型/项目/日期 + 相似度条
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, History, X , SearchX} from 'lucide-react';
import EmptyState from '../components/EmptyState';
import { api, type RecallHit, type Stats, toDateStr } from '../api';
import { useDetail } from '../components/DetailDrawer';
import GradientText from '../components/anim/GradientText';

const HISTORY_KEY = 'hippo.recall.history';
const HISTORY_MAX = 8;

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; }
}

export default function RecallPage() {
  const { t } = useTranslation();
  const { openDetail } = useDetail();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [limit, setLimit] = useState(10);
  const [hits, setHits] = useState<RecallHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);

  useEffect(() => { api.stats().then(setStats).catch(() => {}); }, []);

  const run = async (q?: string) => {
    const text = (q ?? query).trim();
    if (!text) return;
    if (q !== undefined) setQuery(q);
    setLoading(true); setError('');
    try {
      const results = await api.recall(text, { project: project || undefined, limit });
      setHits(results);
      setHistory(prev => {
        const next = [text, ...prev.filter(h => h !== text)].slice(0, HISTORY_MAX);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
        return next;
      });
    } catch (e) { setError((e as Error).message); setHits([]); }
    setLoading(false);
  };

  // 示例查询：通用问题 + 热门项目动态生成
  const suggestions: string[] = [
    '踩过什么坑',
    '构建流程的教训',
    '我的偏好',
    ...Object.entries(stats?.byProject ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => `${p} 项目记得什么`),
  ];

  const topProjects = Object.entries(stats?.byProject ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 10);

  return (
    <div>
      <h2><GradientText>{t('recall.title')}</GradientText></h2>
      <p className="sub">{t('recall.subtitle')}</p>

      <div className="filter-bar">
        <div className="filter-row">
          <div className="filter-search" style={{ maxWidth: 480 }}>
            <Search size={14} className="fs-ico" />
            <input type="search" value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && run()}
              placeholder={t('recall.placeholder')}
              autoFocus />
          </div>
          <button className="btn primary" onClick={() => run()} disabled={loading || !query.trim()}>
            {loading ? `${t('recall.recallBtn')}…` : t('recall.recallBtn')}
          </button>
          <span className="muted">{t('recall.limit')}</span>
          <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
            {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        {topProjects.length > 0 && (
          <div className="filter-row">
            <span className="fgroup">项目</span>
            <div className="chips fchips">
              <button className={`fchip${project === '' ? ' on' : ''}`} onClick={() => setProject('')}>全部</button>
              {topProjects.map(([p, n]) => (
                <button key={p} className={`fchip${project === p ? ' on' : ''}`} onClick={() => setProject(project === p ? '' : p)}>
                  {p} <span className="fn">{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* 空状态：示例查询 + 搜索历史 */}
      {!hits && !error && (
        <div style={{ marginTop: 26 }}>
          <div className="sub" style={{ marginBottom: 8 }}>试试问（点击直接搜）：</div>
          <div className="chips fchips" style={{ gap: 6 }}>
            {suggestions.map(s => (
              <button key={s} className="fchip" onClick={() => run(s)}>{s}</button>
            ))}
          </div>
          {history.length > 0 && (
            <>
              <div className="sub" style={{ margin: '16px 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <History size={13} /> 最近搜索
                <button className="fs-clear" title="清空历史" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-muted)', display: 'inline-flex', alignItems: 'center' }}
                  onClick={() => { setHistory([]); try { localStorage.removeItem(HISTORY_KEY); } catch { /* 忽略 */ } }}>
                  <X size={12} />
                </button>
              </div>
              <div className="chips fchips" style={{ gap: 6 }}>
                {history.map(h => (
                  <button key={h} className="fchip" onClick={() => run(h)}>{h}</button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {hits && (
        hits.length === 0 ? (
          <EmptyState icon={SearchX} title="没有召回到相关记忆" hint="换个问法试试——语义搜索找的是意思相近的记忆，不是字面匹配。" />
        ) : (
          <div className="cards" style={{ marginTop: 14 }}>
            {hits.map((h) => (
              <div className="card" data-type={h.type} key={h.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(h.id)}>
                <div className="text">{h.text}</div>
                <div className="meta">
                  <span className="type">{t(`type.${h.type}`)}</span>
                  <span>{h.project}</span>
                  {h.agent && <span>{h.agent}</span>}
                  <span className="muted">{h.created_at ? toDateStr(h.created_at) : ''}</span>
                  <span className="score-bar"><span style={{ width: `${Math.min(100, h.score * 100)}%` }} /></span>
                  <span>{t('recall.score')} {h.score.toFixed(3)}</span>
                  <span className="muted">{t('recall.sim')} {h.similarity.toFixed(3)}</span>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
