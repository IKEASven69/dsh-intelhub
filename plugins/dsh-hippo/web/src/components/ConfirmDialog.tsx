import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Themed, i18n-friendly confirm dialog. Replaces window.confirm() whose button
 * labels can't be translated and don't match the purple theme.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      // Only confirm on Enter when not focused in a text field — otherwise
      // pressing Enter inside an input would accidentally trigger confirm.
      if (e.key === 'Enter') {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-dialog" onClick={e => e.stopPropagation()} role="alertdialog" aria-label={title}>
        <header><h3>{title}</h3></header>
        <div className="body">
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{message}</div>
          {children}
        </div>
        <div className="actions">
          <button onClick={onCancel}>{cancelLabel ?? t('common.cancel')}</button>
          <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel ?? t('common.confirm')}</button>
        </div>
      </div>
    </div>
  );
}
