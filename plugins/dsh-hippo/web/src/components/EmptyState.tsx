/**
 * 统一空状态组件：图标 + 标题 + 引导文案 + 可选操作按钮。
 * 替换 6 个页面各自的 `.empty` 干文案——数据少/为零时给用户方向感。
 */
import type { LucideIcon } from 'lucide-react';

export default function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '48px 24px', gap: 12, textAlign: 'center',
      border: '1px dashed var(--border)', borderRadius: 12,
      background: 'var(--surface-1)',
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12, display: 'grid', placeItems: 'center',
        background: 'var(--surface-2)', color: 'var(--ink-muted)',
      }}>
        <Icon size={22} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
      {hint && <div className="muted" style={{ fontSize: 13, maxWidth: 360, lineHeight: 1.6 }}>{hint}</div>}
      {action && (
        <button className="btn primary" style={{ marginTop: 6 }} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
