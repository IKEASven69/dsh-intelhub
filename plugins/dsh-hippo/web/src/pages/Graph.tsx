import { Network } from 'lucide-react';
import { useEffect, useState, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import EmptyState from '../components/EmptyState';
import { api, type MemoryRecord, MEMORY_TYPES } from '../api';
import { useDetail } from '../components/DetailDrawer';
import GradientText from '../components/anim/GradientText';

const TOP_N = 200;
const SIM_THRESHOLD = 0.7;

// Type accent colors — read from the CSS custom properties at runtime so the
// graph stays in sync with the theme (light/dark) without hardcoding hex.
const TYPE_COLORS: Record<string, string> = {
  fact: '#7c3aed',
  decision: '#ea6a33',
  lesson: '#16a87a',
  preference: '#64748b',
};

interface GNode { id: string; text: string; type: string; project: string; strength: number; x?: number; y?: number; }
interface GLink { source: string | GNode; target: string | GNode; similarity: number; }

// force-graph mutates link.source/target into node object refs after simulation;
// normalize to an id string either way.
const linkId = (end: string | GNode): string => typeof end === 'string' ? end : end.id;

export default function GraphPage() {
  const { t } = useTranslation();
  const { openDetail } = useDetail();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [edges, setEdges] = useState<GLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);

  // Precompute neighbor sets so hover can highlight a node's connected component.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of edges) {
      const s = linkId(l.source), t = linkId(l.target);
      (m.get(s) ?? m.set(s, new Set()).get(s)!).add(t);
      (m.get(t) ?? m.set(t, new Set()).get(t)!).add(s);
    }
    return m;
  }, [edges]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError('');
      try {
        // 批量端点：一次请求出节点+边（旧逐条 similar 200 次 × 2s 会卡 7 分钟）
        const g = await api.graphEdges(TOP_N, SIM_THRESHOLD);
        if (cancelled) return;
        setMemories(g.nodes as unknown as MemoryRecord[]);
        setEdges(g.edges as GLink[]);
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const graphData = useMemo(() => {
    const nodes: GNode[] = memories.map(m => ({
      id: m.id, text: m.text, type: m.type, project: m.project, strength: m.strength,
    }));
    return { nodes, links: edges };
  }, [memories, edges]);

  const onNodeClick = (node: GNode) => openDetail(node.id);

  // Push nodes apart so the graph breathes — default d3 charge clusters
  // everything into a tight blob. Stronger negative charge + a link distance
  // floor give the glowing dots room to read.
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    const charge = fg.d3Force('charge');
    if (charge) charge.strength(-180);
    const link = fg.d3Force('link');
    if (link) link.distance(70);
    fg.d3ReheatSimulation();
  }, [memories, edges]);

  // Lazy-load the force-graph canvas component (heavy ~200KB) only when needed.
  const [ForceGraph2D, setComponent] = useState<any>(null);
  // Track container size so the canvas resizes with the window (reading
  // containerRef.current during render captures the size once at mount and
  // never updates — a state + ResizeObserver keeps it live).
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    import('react-force-graph-2d').then(mod => setComponent(() => mod.default));
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, memories.length]);

  return (
    <div>
      <h2><GradientText>{t('graph.title')}</GradientText></h2>
      <p className="sub">{t('graph.subtitle', { threshold: SIM_THRESHOLD })}</p>

      {error && <div className="error-banner">{error}</div>}

      {loading && !error && (
        <div className="graph-container">
          <div className="empty">{t('graph.loading')}</div>
        </div>
      )}

      {!loading && memories.length < 2 && !error && (
        <div className="graph-container">
          <EmptyState icon={Network} title="暂无图谱数据" hint="记忆达到 2 条以上后自动生成语义关联网络；点击节点看详情，拖拽布局。" />
        </div>
      )}

      {!loading && memories.length >= 2 && !error && ForceGraph2D && (
        <>
          {memories.length === TOP_N && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {t('graph.topN', { count: TOP_N })}
            </div>
          )}
          <div className="graph-container" ref={containerRef}>
            <div className="graph-controls">
              <button className="small" onClick={() => graphRef.current?.zoomToFit(400, 40)}>
                {t('graph.zoomFit')}
              </button>
            </div>
            <div className="graph-legend">
              {MEMORY_TYPES.map(ty => (
                <div className="legend-item" key={ty}>
                  <span className="legend-dot" style={{ background: TYPE_COLORS[ty] }} />
                  {t(`type.${ty}`)}
                </div>
              ))}
            </div>
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData}
              backgroundColor="#0b0918"
              nodeRelSize={6}
              nodeColor={(n: GNode) => TYPE_COLORS[n.type] ?? '#888'}
              nodeLabel={(n: GNode) => n.text.slice(0, 120)}
              linkColor={(l: GLink) => {
                const baseAlpha = 0.15 + (l.similarity - SIM_THRESHOLD) * 1.2;
                if (!hoverId) return `rgba(167,139,250,${baseAlpha})`;
                const active = linkId(l.source) === hoverId || linkId(l.target) === hoverId;
                return active ? 'rgba(196,181,253,0.9)' : 'rgba(120,110,160,0.05)';
              }}
              linkWidth={(l: GLink) => Math.max(0.6, (l.similarity - SIM_THRESHOLD) * 10)}
              linkDirectionalParticles={0}
              onNodeClick={onNodeClick}
              onNodeHover={(n: GNode | null) => setHoverId(n?.id ?? null)}
              cooldownTicks={120}
              d3AlphaDecay={0.015}
              d3VelocityDecay={0.3}
              enableNodeDrag
              width={size.w}
              height={size.h}
              nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D) => {
                const n = node as GNode & { x: number; y: number };
                const color = TYPE_COLORS[n.type] ?? '#888';
                const isHover = hoverId === n.id;
                const isNeighbor = hoverId !== null && (neighbors.get(hoverId)?.has(n.id) ?? false) ;
                const dimmed = hoverId !== null && !isHover && !isNeighbor;
                // size grows with strength; hover gets a bump
                const r = (5 + n.strength * 2.5) * (isHover ? 1.5 : 1) * (dimmed ? 0.7 : 1);
                // outer glow
                ctx.shadowBlur = isHover ? 28 : 16;
                ctx.shadowColor = color;
                // translucent halo
                ctx.beginPath();
                ctx.arc(n.x, n.y, r + 4, 0, 2 * Math.PI);
                ctx.fillStyle = color + (dimmed ? '14' : '26');
                ctx.fill();
                // solid core
                ctx.beginPath();
                ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = dimmed ? color + '88' : color;
                ctx.fill();
                ctx.shadowBlur = 0;
                // label: only when this node is part of the hovered component
                // (the hovered node or one of its direct neighbors). Default
                // view is clean glowing dots — labels for every node would
                // pile on top of each other and obscure the structure.
                const showLabel = isHover || isNeighbor;
                if (showLabel) {
                  const label = n.text.length > 30 ? n.text.slice(0, 29) + '…' : n.text;
                  ctx.font = `${isHover ? 13 : 11}px system-ui, "Microsoft YaHei", sans-serif`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'top';
                  // halo behind text for readability on dark bg
                  ctx.fillStyle = 'rgba(11,9,24,0.8)';
                  const tw = ctx.measureText(label).width;
                  ctx.fillRect(n.x - tw / 2 - 4, n.y + r + 4, tw + 8, isHover ? 18 : 16);
                  ctx.fillStyle = isHover ? '#ffffff' : '#c3bdd6';
                  ctx.fillText(label, n.x, n.y + r + 5);
                }
              }}
            />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {t('graph.nodes', { count: graphData.nodes.length })} · {t('graph.edges', { count: graphData.links.length })}
          </div>
        </>
      )}
    </div>
  );
}
