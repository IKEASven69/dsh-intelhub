/**
 * 系统状态栏：GUI 顶部常驻显示——自动蒸馏状态 + 待审队列 + 编译配置。
 * 解决"静默失败"问题：用户一眼看到 hippo 是否在工作。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle, Clock, FileText, PauseCircle } from 'lucide-react';

interface HealthData {
  autoDistill: {
    mode: string;
    threshold: number;
    intervalMin: number;
    lastRunAt: number | null;
    lastRun: { scanned: number; created: number; reinforced: number; shelved: number } | null;
    running: boolean;
  };
  shelvedQueue: number;
  memoryCount: number;
  compileTargets: Array<{ project: string; outPath: string; lastCompiledAt: number; memoryCount: number }>;
}

function timeAgo(ts: number | null): string {
  if (!ts) return '从未';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export default function StatusBar() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const load = () => {
      void fetch('/api/health')
        .then(r => r.json())
        .then(setHealth)
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30_000); // 30秒刷新
    return () => clearInterval(timer);
  }, []);

  if (health === null) return null;

  const auto = health.autoDistill;
  const stopped = !auto.running;
  const hasShelved = health.shelvedQueue > 0;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '6px 14px',
      borderBottom: '1px solid var(--border)', fontSize: 12.5, flexWrap: 'wrap',
      background: stopped ? 'rgba(211,47,47,.06)' : 'var(--surface-1)',
    }}>
      {/* 自动蒸馏状态 */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {stopped ? <PauseCircle size={13} color="var(--danger)" /> : <CheckCircle size={13} color="var(--success)" />}
        {stopped ? (
          <b style={{ color: 'var(--danger)' }}>自动蒸馏已停止</b>
        ) : (
          <>自动蒸馏 <b>{auto.mode === 'auto' ? '自动入库' : '全进待审'}</b></>
        )}
        {auto.lastRun && (
          <span className="muted" style={{ marginLeft: 4 }}>
            · 上轮 {timeAgo(auto.lastRunAt)}（+{auto.lastRun.created}）
          </span>
        )}
      </span>

      {/* 待审队列 */}
      {hasShelved && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
          onClick={() => { navigate('/distill'); }}
          title="点击去蒸馏页处理">
          <Clock size={13} color="var(--warning)" />
          <b style={{ color: 'var(--warning)' }}>{health.shelvedQueue} 条待审</b>
        </span>
      )}

      {/* 记忆总数 */}
      <span className="muted">
        <b>{health.memoryCount}</b> 条记忆
      </span>

      {/* 编译配置 */}
      {health.compileTargets.length > 0 ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <FileText size={13} className="muted" />
          {health.compileTargets.map((t, i) => (
            <span key={i} className="muted" title={`${t.outPath} (${t.memoryCount} 条)`}>
              {t.project}{i < health.compileTargets.length - 1 ? ' ·' : ''}
            </span>
          ))}
          <span className="muted">自动编译中</span>
        </span>
      ) : (
        <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <AlertTriangle size={13} color="var(--warning)" />
          手动编译一次即可开启自动编译
        </span>
      )}
    </div>
  );
}
