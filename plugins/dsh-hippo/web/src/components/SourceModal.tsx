import { useEffect, useState, useRef, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type SourceBlob, type SourceTurn } from '../api';

/**
 * Modal showing the L0 source transcript a memory was distilled from.
 *
 * Renders turns as chat bubbles (user left / assistant right), with the
 * turn nearest `highlightOffset` outlined so the user sees where the
 * extraction came from.
 */
export function SourceModal({
  sourceId,
  highlightOffset,
  onClose,
}: {
  sourceId: string;
  highlightOffset?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [blob, setBlob] = useState<SourceBlob | null>(null);
  const [error, setError] = useState('');
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSource(sourceId).then(b => { if (!cancelled) setBlob(b); })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [sourceId]);

  // Scroll the highlighted turn into view once loaded.
  useEffect(() => {
    if (blob && highlightOffset !== undefined && highlightOffset >= 0) {
      // Defer so the DOM is painted before scrolling.
      const timer = setTimeout(() => highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
      return () => clearTimeout(timer);
    }
  }, [blob, highlightOffset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const turns = blob?.turns ?? [];
  // Pick the turn index to highlight: source_offset, clamped to range.
  const highlightIdx = highlightOffset !== undefined && highlightOffset >= 0 && highlightOffset < turns.length
    ? Math.floor(highlightOffset)
    : -1;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={t('source.title')}>
        <header>
          <h3>{t('source.title')}</h3>
          <button className="small" onClick={onClose}>✕</button>
        </header>
        <div className="body">
          {error && <div className="error-banner">{error}</div>}
          {!blob && !error && <div className="empty">{t('common.loading')}</div>}
          {blob && (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
                {t('source.turns', { count: blob.turn_count })}
                {blob.truncated && ` · ${t('source.truncated', { original: blob.original_turn_count })}`}
                {' · '}{blob.project}{' · '}{blob.agent}
              </div>
              {turns.map((turn, i) => (
                <TurnBubble
                  key={i}
                  ref={i === highlightIdx ? highlightRef : undefined}
                  turn={turn}
                  highlight={i === highlightIdx}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const TurnBubble = forwardRef<HTMLDivElement, { turn: SourceTurn; highlight: boolean }>(
  function TurnBubble({ turn, highlight }, ref) {
    const { t } = useTranslation();
    const role = (turn.role ?? 'unknown').toLowerCase();
    const isUser = role.includes('user') || role === 'human';
    const text = typeof turn.text === 'string' ? turn.text : JSON.stringify(turn.text ?? '');
    return (
      <div ref={ref} className={`turn ${isUser ? 'user' : 'assistant'}${highlight ? ' highlight' : ''}`}>
        <div className="turn-role">{role}{highlight && `  ← ${t('source.highlight')}`}</div>
        <div className="turn-bubble">{text}</div>
      </div>
    );
  },
);
