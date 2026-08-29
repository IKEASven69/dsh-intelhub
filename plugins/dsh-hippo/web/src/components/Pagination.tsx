/**
 * 共享分页：页码按钮（多页时两端+当前页±1 带省略号）+ 跳页输入 + 共 N 条 · M 页。
 * 记忆/会话等列表页统一使用。
 */
import { useState, useEffect } from 'react';

function pageList(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const set = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const out: (number | '…')[] = [];
  let prev = 0;
  for (const p of [...set].filter(p => p >= 1 && p <= pageCount).sort((a, b) => a - b)) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

export default function Pagination({ page, pageCount, total, onChange }: {
  page: number
  pageCount: number
  total: number
  onChange: (page: number) => void
}) {
  const [jump, setJump] = useState('');
  useEffect(() => { setJump(''); }, [page]);

  if (pageCount <= 1) {
    return <div className="meta" style={{ textAlign: 'center', marginTop: 10, fontSize: 12 }}>共 {total} 条</div>;
  }

  const doJump = () => {
    const n = parseInt(jump, 10);
    if (Number.isFinite(n)) onChange(Math.min(Math.max(1, n), pageCount));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
      <button className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>←</button>
      {pageList(page, pageCount).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="meta" style={{ fontSize: 12, padding: '0 2px' }}>…</span>
        ) : (
          <button key={p} className={`btn${p === page ? ' primary' : ''}`} style={{ minWidth: 32, padding: '4px 8px' }}
            onClick={() => onChange(p)}>{p}</button>
        )
      )}
      <button className="btn" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>→</button>
      <span className="meta" style={{ fontSize: 12, marginLeft: 6 }}>
        共 {total} 条 · 第 {page} / {pageCount} 页
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
        <input className="pg-jump" type="number" min={1} max={pageCount} value={jump} placeholder="页"
          onChange={e => setJump(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') doJump(); }} />
        <button className="btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={doJump} disabled={jump === ''}>跳</button>
      </span>
    </div>
  );
}
