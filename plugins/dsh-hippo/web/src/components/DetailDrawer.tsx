import { useEffect, useState, createContext, useContext, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type MemoryRecord, type RecallHit, toDateStr } from '../api';
import { SourceModal } from './SourceModal';

/**
 * Detail drawer + a context hook so any page can open it by memory id.
 *
 * Usage in a page:
 *   const openDetail = useDetail();
 *   <div onClick={() => openDetail(mem.id)}>...</div>
 * The <DetailProvider> lives once at the app root (main.tsx) and renders the
 * drawer; consumers just call openDetail(id).
 */

interface DetailCtx { openDetail: (id: string) => void; }
const Ctx = createContext<DetailCtx>({ openDetail: () => {} });
export const useDetail = () => useContext(Ctx);

export function DetailProvider({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const openDetail = useCallback((id: string) => setOpenId(id), []);
  const close = useCallback(() => setOpenId(null), []);

  // 分割视图：面板打开时 body 加标记 → .main 缩窄让出右列
  useEffect(() => {
    document.body.classList.toggle('has-detail-panel', openId !== null);
    return () => { document.body.classList.remove('has-detail-panel'); };
  }, [openId]);

  return (
    <Ctx.Provider value={{ openDetail }}>
      {children}
      {openId && <DetailPanel id={openId} onClose={close} />}
    </Ctx.Provider>
  );
}

function DetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { openDetail } = useDetail();
  const [mem, setMem] = useState<MemoryRecord | null>(null);
  const [similar, setSimilar] = useState<RecallHit[] | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMem(null); setSimilar(null); setShowSource(false);
    (async () => {
      try {
        const m = await api.getMemory(id);
        if (cancelled) return;
        setMem(m);
        const sim = await api.similar(id, 4);
        if (cancelled) return;
        setSimilar(sim);
      } catch { /* ignore — panel just shows what it has */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <aside className="detail-panel" role="complementary" aria-label={t('detail.title')}>
        <header className="detail-panel-header">
          <h3>{mem ? t(`type.${mem.type}`) : t('common.loading')}</h3>
          <button className="small" onClick={onClose}>✕</button>
        </header>
        <div className="body">
          {loading && <div className="empty">{t('common.loading')}</div>}
          {mem && (
            <>
              <div className="detail-text">{mem.text}</div>
              {mem.superseded_by && (
                <div className="card" style={{ padding: '6px 10px', borderColor: 'var(--s2)', fontSize: 12.5 }}>
                  ⚑ 已被更新版取代（保留可查）{mem.chain?.newer && (
                    <>
                      <div className="muted" style={{ marginTop: 2 }}>现行版（{toDateStr(mem.chain.newer.created_at)}）：</div>
                      <div style={{ cursor: 'pointer', color: 'var(--s1)' }} onClick={() => openDetail(mem.chain!.newer!.id)}>
                        {mem.chain.newer.text.slice(0, 90)}{mem.chain.newer.text.length > 90 ? '…' : ''}
                      </div>
                    </>
                  )}
                </div>
              )}
              {mem.chain?.older && (
                <div className="card" style={{ padding: '6px 10px', fontSize: 12.5 }}>
                  ⇱ 这条取代了早前版本（{toDateStr(mem.chain.older.created_at)}）：
                  <div style={{ cursor: 'pointer', color: 'var(--ink-2)' }} onClick={() => openDetail(mem.chain!.older!.id)}>
                    {mem.chain.older.text.slice(0, 90)}{mem.chain.older.text.length > 90 ? '…' : ''}
                  </div>
                </div>
              )}
              <dl className="detail-meta">
                <dt>{t('detail.project')}</dt><dd>{mem.project}</dd>
                <dt>{t('detail.agent')}</dt><dd>{mem.agent || '—'}</dd>
                <dt>{t('detail.strength')}</dt><dd>{mem.strength.toFixed(2)}</dd>
                <dt>{t('detail.created')}</dt><dd>{toDateStr(mem.created_at)}</dd>
                {mem.accessed_at && mem.accessed_at !== mem.created_at && (
                  <>
                    <dt>{t('detail.accessed')}</dt><dd>{toDateStr(mem.accessed_at)}</dd>
                  </>
                )}
              </dl>

              {/* Source provenance (L0 transcript) */}
              <div className="section-label">{t('detail.source')}</div>
              {mem.source_id ? (
                <>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t('detail.fromDistill', { date: toDateStr(mem.accessed_at || mem.created_at) })}
                  </div>
                  <span className="source-link" onClick={() => setShowSource(true)}>
                    {t('detail.viewSource')} →
                  </span>
                </>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>{t('detail.noSource')}</div>
              )}

              {/* Similar memories */}
              <div className="section-label">{t('detail.similar')}</div>
              {similar === null ? (
                <div className="muted" style={{ fontSize: 12 }}>{t('detail.loadingSimilar')}</div>
              ) : similar.length === 0 ? (
                <div className="muted" style={{ fontSize: 12 }}>{t('detail.noSimilar')}</div>
              ) : (
                similar.map(s => (
                  <div
                    key={s.id}
                    className="similar-card"
                    data-type={s.type}
                    style={{ borderLeft: '3px solid var(--s1)', paddingLeft: 10 }}
                    onClick={() => openDetail(s.id)}
                  >
                    <div className="sim-text">{s.text}</div>
                    <div className="sim-meta">
                      {t(`type.${s.type}`)} · {s.project} · {t('recall.sim')} {s.similarity.toFixed(3)}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </aside>
      {showSource && mem?.source_id && (
        <SourceModal sourceId={mem.source_id} highlightOffset={mem.source_offset} onClose={() => setShowSource(false)} />
      )}
    </>
  );
}
