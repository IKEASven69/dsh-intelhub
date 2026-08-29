/**
 * 时间线页：全量记忆按时间浏览。
 * - 粒度切换：按日 / 按月 / 按年（分组标题 + 时间线竖轴）
 * - 可拖动时间轴（密度条）：每段宽度∝该时段记忆量，拖动/点击跳到对应页
 * - 共享分页（50 条/页）；数据拉全量（按 total 翻页循环，不再 500 截断）
 * - 筛选：工作区 → 项目 级联（与其他页一致）
 */
import { CalendarDays } from 'lucide-react';
import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import EmptyState from '../components/EmptyState';
import { api, workspaceOf, type MemoryRecord, toDateStr } from '../api';
import { useDetail } from '../components/DetailDrawer';
import Pagination from '../components/Pagination';
import GradientText from '../components/anim/GradientText';

type Granularity = 'day' | 'month' | 'year';
const PAGE = 50;

/** 时间线的"有效时间"：优先原会话时间（事情发生的时候），回退记忆写入时间。 */
function when(m: MemoryRecord): number {
  return (m.origin_ts && m.origin_ts > 0 ? m.origin_ts : m.created_at) ?? 0;
}

function timeKey(ts: number, g: Granularity): string {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '未知';
  const y = d.getFullYear();
  if (g === 'year') return String(y);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  if (g === 'month') return `${y}-${mo}`;
  return `${y}-${mo}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function TimelinePage() {
  const { t, i18n } = useTranslation();
  const { openDetail } = useDetail();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [filterProject, setFilterProject] = useState('');
  const [gran, setGran] = useState<Granularity>('month');
  const [page, setPage] = useState(1);
  const [selDay, setSelDay] = useState(''); // 选中的天（贡献方格描边，纯选中语义）
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [allProjects, setAllProjects] = useState<[string, number][]>([]);
  const [ws, setWs] = useState('');
  const [projWs, setProjWs] = useState<Record<string, string>>({}); // 项目名 → 工作区
  useEffect(() => {
    api.listMemories({ limit: 500 }).then(r => {
      const c: Record<string, number> = {};
      for (const m of r.memories) c[m.project] = (c[m.project] ?? 0) + 1;
      setAllProjects(Object.entries(c).sort((a, b) => b[1] - a[1]));
    }).catch(() => {});
    // 项目名 → 工作区映射（来自会话 cwd；手工记忆无会话则归“其他”）
    api.listSessions({ limit: 500 }).then(r => {
      const map: Record<string, string> = {};
      for (const s of r.sessions) map[s.project] = workspaceOf(s.cwd) || '其他';
      setProjWs(map);
    }).catch(() => {});
  }, []);

  // 拉全量：按服务端 total 翻页循环（旧实现 500 截断 → 只剩最近月份）
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    (async () => {
      try {
        const out: MemoryRecord[] = [];
        let total = Infinity;
        while (out.length < total) {
          const r = await api.listMemories({ project: filterProject || undefined, limit: 500, offset: out.length });
          if (cancelled) return;
          total = r.total;
          out.push(...r.memories);
          if (r.memories.length === 0) break;
        }
        if (cancelled) return;
        // Oldest first so the timeline reads top→bottom chronologically.
        out.sort((a, b) => when(a) - when(b));
        setMemories(out);
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [filterProject]);

  useEffect(() => { setPage(1); setSelDay(''); }, [filterProject, gran]);

  // 当前页条目（时间正序分页）
  const pageCount = Math.max(1, Math.ceil(memories.length / PAGE));
  const pageItems = useMemo(
    () => memories.slice((page - 1) * PAGE, page * PAGE),
    [memories, page],
  );

  // 分组（当前粒度），组内保持时间正序
  const groups = useMemo(() => {
    const g: { key: string; items: MemoryRecord[] }[] = [];
    const idx = new Map<string, number>();
    for (const m of pageItems) {
      const key = timeKey(when(m), gran);
      let i = idx.get(key);
      if (i === undefined) { i = g.length; idx.set(key, i); g.push({ key, items: [] }); }
      g[i].items.push(m);
    }
    return g;
  }, [pageItems, gran]);

  // 按天计数 + 每天第一条在全量里的序号（贡献方格点击跳页用）
  const dayIndex = useMemo(() => {
    const m = new Map<string, { count: number; startIdx: number }>();
    for (let i = 0; i < memories.length; i++) {
      const key = timeKey(when(memories[i]), 'day');
      if (key === '未知') continue;
      const e = m.get(key);
      if (e) e.count++;
      else m.set(key, { count: 1, startIdx: i });
    }
    return m;
  }, [memories]);

  const label = useCallback((key: string, g: Granularity) => {
    if (g === 'year') return `${key} 年`;
    const [y, mo, d] = key.split('-');
    const locale = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
    if (g === 'month') {
      return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString(locale, { year: 'numeric', month: 'long' });
    }
    return new Date(Number(y), Number(mo) - 1, Number(d)).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  }, [i18n.language]);

  if (loading) return <div className="empty">{t('common.loading')}</div>;

  return (
    <div>
      <h2><GradientText>{t('timeline.title')}</GradientText></h2>
      <p className="sub">{t('timeline.subtitle')}</p>

      <div className="toolbar">
        <span className="label">工作区</span>
        <div className="chips fchips">
          <button className={`fchip${ws === '' ? ' on' : ''}`} onClick={() => { setWs(''); setFilterProject(''); }}>全部</button>
          {Object.entries(allProjects.reduce<Record<string, number>>((acc, [p, n]) => {
            const w = projWs[p] ?? '其他';
            acc[w] = (acc[w] ?? 0) + n;
            return acc;
          }, {})).sort((a, b) => b[1] - a[1]).map(([w, n]) => (
            <button key={w} className={`fchip${ws === w ? ' on' : ''}`} onClick={() => { setWs(ws === w ? '' : w); setFilterProject(''); }}>
              {w} <span className="fn">{n}</span>
            </button>
          ))}
        </div>
      </div>
      {ws !== '' && (
        <div className="toolbar">
          <span className="label">{t('memories.filterProject')}</span>
          <div className="chips fchips">
            <button className={`fchip${filterProject === '' ? ' on' : ''}`} onClick={() => setFilterProject('')}>全部</button>
            {allProjects.filter(([p]) => (projWs[p] ?? '其他') === ws).map(([p, n]) => (
              <button key={p} className={`fchip${filterProject === p ? ' on' : ''}`} onClick={() => setFilterProject(filterProject === p ? '' : p)}>
                {p} <span className="fn">{n}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 粒度切换 */}
      <div className="toolbar">
        <span className="label">粒度</span>
        <div className="chips fchips">
          {([['day', '按日'], ['month', '按月'], ['year', '按年']] as [Granularity, string][]).map(([g, l]) => (
            <button key={g} className={`fchip${gran === g ? ' on' : ''}`} onClick={() => setGran(g)}>{l}</button>
          ))}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* GitHub 式贡献方格：颜色深浅=当天记忆量，点击选中该天并跳到所在页 */}
      <ContributionGrid
        dayIndex={dayIndex}
        selected={selDay}
        onSelect={(k) => setSelDay(k)}
        onPage={setPage}
      />

      {memories.length === 0 && !error ? (
        <EmptyState icon={CalendarDays} title="暂无时间线数据" hint="蒸馏会话后记忆会按真实发生时间出现在贡献方格里。" />
      ) : (
        <div className="timeline">
          {groups.map(g => (
            <div className="timeline-month" key={g.key}>
              <h3>{label(g.key, gran)} · {t('timeline.monthCount', { count: g.items.length })}</h3>
              {g.items.map(m => (
                <div
                  key={m.id}
                  className="timeline-entry card"
                  data-type={m.type}
                  style={{ cursor: 'pointer' }}
                  onClick={() => openDetail(m.id)}
                >
                  <div className="text" style={{ fontSize: 13 }}>{m.text}</div>
                  <div className="meta">
                    <span className="type">{t(`type.${m.type}`)}</span>
                    <span>{m.project}</span>
                    <span>{toDateStr(when(m))}</span>
                    {m.origin_ts && m.origin_ts > 0 && <span className="muted">记录于 {toDateStr(m.created_at)}</span>}
                    {m.accessed_at && m.accessed_at !== m.created_at && (
                      <span className="muted">{t('timeline.accessed', { date: toDateStr(m.accessed_at) })}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <Pagination page={page} pageCount={pageCount} total={memories.length} onChange={setPage} />
    </div>
  );
}

/** GitHub 式贡献方格：列=周 行=周一~周日，颜色深浅=当天记忆量；
 * 点击选中该天（描边）并跳到它所在页；翻页不牵连选中。
 * 方格大小随容器宽度自适应（窄面板缩小塞下全部月份），实在放不下才横向滚动。 */
function ContributionGrid({ dayIndex, selected, onSelect, onPage }: {
  dayIndex: Map<string, { count: number; startIdx: number }>
  selected: string
  onSelect: (key: string) => void
  onPage: (p: number) => void
}) {
  const keys = [...dayIndex.keys()].sort();
  // 色阶用四分位（GitHub 同款）：按有数据天数的分布取 25/50/75 分位，
  // 线性 max 会被单个导入巨日压平，其余天全变最浅档看着像空的。
  const sortedCounts = [...dayIndex.values()].map(v => v.count).sort((a, b) => a - b);
  const q = (p: number) => sortedCounts[Math.min(sortedCounts.length - 1, Math.floor(p * sortedCounts.length))] ?? 1;
  const t1 = Math.max(1, q(0.25)), t2 = Math.max(t1 + 1, q(0.5)), t3 = Math.max(t2 + 1, q(0.75));
  const level = (n: number) => (n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);

  const start = keys.length ? new Date(keys[0] + 'T00:00:00') : new Date();
  const end = keys.length ? new Date(keys[keys.length - 1] + 'T00:00:00') : new Date();
  // 对齐到周一/周日，补满首尾周
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));

  const weeks: Date[][] = [];
  const monthLabels: (number | null)[] = [];
  const cur = new Date(start);
  let lastMonth = -1;
  while (cur <= end) {
    const col: Date[] = [];
    for (let d = 0; d < 7; d++) { col.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
    weeks.push(col);
    // 该周第一天的月份变化时打标签（GitHub 同款）
    const m = col[0].getMonth() + 12 * col[0].getFullYear();
    monthLabels.push(m !== lastMonth ? col[0].getMonth() : null);
    lastMonth = m;
  }

  // 方格自适应：格子大小按容器宽/周数算，13px 封顶、7px 下限
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(13);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || weeks.length === 0) return;
    const update = () => {
      const w = el.clientWidth - 28; // 左右 padding
      const size = Math.floor((w - (weeks.length - 1) * 4) / weeks.length);
      setCellSize(Math.max(7, Math.min(13, size)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks.length]);

  if (weeks.length === 0) return null;
  const fmt = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;

  return (
    <div className="tl-heat" ref={wrapRef} title="">
      <div className="tl-heat-inner">
        <div className="tl-heat-months" style={{ gap: 4 }}>
          {monthLabels.map((m, i) => <span key={i} style={{ width: cellSize }}>{m !== null ? `${m + 1}月` : ''}</span>)}
        </div>
        <div className="tl-heat-grid" style={{ gap: 4 }}>
          {weeks.map((col, wi) => (
            <div className="tl-heat-col" key={wi} style={{ gap: cellSize >= 11 ? 4 : 3 }}>
              {col.map(d => {
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                const e = dayIndex.get(key);
                const lv = e ? level(e.count) : 0;
                return (
                  <div key={key}
                    className={`tl-heat-cell${e ? ' has' : ''}${key === selected ? ' now' : ''}`}
                    data-l={lv}
                    style={{ width: cellSize, height: cellSize }}
                    title={e ? `${fmt(d)} · ${e.count} 条（点击选中并跳页）` : fmt(d)}
                    onClick={() => { if (e) { onSelect(key); onPage(Math.floor(e.startIdx / PAGE) + 1); } }}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="tl-heat-legend">
          少
          <span className="tl-heat-cell" data-l="1" />
          <span className="tl-heat-cell" data-l="2" />
          <span className="tl-heat-cell" data-l="3" />
          <span className="tl-heat-cell" data-l="4" />
          多
        </div>
      </div>
    </div>
  );
}
