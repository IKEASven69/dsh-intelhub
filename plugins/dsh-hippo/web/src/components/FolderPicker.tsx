import { BASE } from '../api'
/**
 * 共享文件夹选择器：走服务端 /api/fs/list 浏览文件系统任意目录。
 * 交互模型（资源管理器式）：点目录行 = 进入看里面的内容（盘符同样可进），
 * 行尾 ✓ = 直接选定该目录，底部"选择此目录" = 选定当前目录。
 * variant="input"：文本框 + 弹出（编译页输出目录）。
 * variant="button"：紧凑按钮 + 弹出（筛选栏选目录，不锁死在工作区 chips）。
 * counts：可选回调，返回某目录下的条目数——有数的目录显示徽标，
 * 浏览整盘时一眼看到哪些文件夹里有会话。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Check, FolderOpen, HardDrive } from 'lucide-react';

export function normPath(p: string): string {
  return p.replace(/[/]/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 段感知前缀匹配：cwd 是否位于 root 之下（D:\co 不会误匹配 D:\coding）。 */
export function underPath(cwd: string, root: string): boolean {
  if (!root) return true;
  const c = normPath(cwd || '');
  const r = normPath(root);
  return c === r || c.startsWith(r + '\\');
}

interface FsList { current: string; parent: string; entries: { name: string; path: string }[] }

export default function FolderPicker({ value, onChange, variant = 'input', counts,
  placeholder = '输出目录（点击选择）', label = '浏览', title = '浏览文件夹选择',
}: {
  value: string;
  onChange: (v: string) => void;
  variant?: 'input' | 'button';
  counts?: (path: string) => number;
  placeholder?: string;
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<FsList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // 快速连续导航时丢弃过期响应：慢目录（如 C:\ 根）的旧响应
  // 晚到会覆盖新目录，导致"点 D: 却弹回 C:"的错乱。
  const seqRef = useRef(0);

  const load = useCallback(async (path?: string) => {
    const seq = ++seqRef.current;
    setBusy(true);
    try {
      const r = await fetch(`${BASE}/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      const d = await r.json();
      if (seq !== seqRef.current) return;
      if (!r.ok) throw new Error(d.error);
      setDirs(d); setError('');
    } catch (e) {
      if (seq === seqRef.current) setError((e as Error).message);
    }
    if (seq === seqRef.current) setBusy(false);
  }, []);

  useEffect(() => { if (open && dirs === null) void load(); }, [open, dirs, load]);

  // 点击外部关闭弹出层
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 目录行：整行点击进入；✓ 选定该目录
  const row = (name: string, path: string, key: string, n?: number) => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6,
      cursor: 'pointer', fontSize: 13, minWidth: 0 }}
      onClick={() => void load(path)}
      onMouseEnter={e2 => (e2.currentTarget as HTMLElement).style.background = 'var(--surface-1)'}
      onMouseLeave={e2 => (e2.currentTarget as HTMLElement).style.background = ''}>
      <FolderOpen size={13} style={{ color: 'var(--s2)', flex: 'none' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {(n ?? 0) > 0 && <span className="fn" style={{ fontSize: 11, flex: 'none' }}>{n}</span>}
      <span title="选定此目录" style={{ marginLeft: 'auto', flex: 'none', display: 'flex', opacity: 0.35, cursor: 'pointer' }}
        onClick={ev => { ev.stopPropagation(); onChange(path); setOpen(false); }}
        onMouseEnter={e2 => (e2.currentTarget as HTMLElement).style.opacity = '1'}
        onMouseLeave={e2 => (e2.currentTarget as HTMLElement).style.opacity = '0.35'}>
        <Check size={13} />
      </span>
    </div>
  );

  return (
    <div ref={boxRef} style={{ position: 'relative', ...(variant === 'input' ? { flex: 1, minWidth: 220 } : {}) }}>
      {variant === 'input' ? (
        <div className="filter-search" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
          <FolderOpen size={14} style={{ color: 'var(--ink-muted)', flex: 'none' }} />
          <input
            placeholder={placeholder}
            value={value}
            onChange={e => onChange(e.target.value)}
            style={{ border: 'none', outline: 'none', background: 'transparent', color: 'inherit', fontSize: 13, flex: 1, minWidth: 0 }}
          />
        </div>
      ) : (
        <button className={`btn ghost${value !== '' ? ' on' : ''}`} title={title} onClick={() => setOpen(!open)}>
          <FolderOpen size={14} style={{ verticalAlign: -2, marginRight: 4 }} />{label}
        </button>
      )}
      {open && (
        <div className="card" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 60, marginTop: 4,
          width: variant === 'input' ? '100%' : 340, maxHeight: 300, overflow: 'auto',
          padding: '8px 10px', textAlign: 'left', boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
          <div className="meta" style={{ fontSize: 11, padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 4,
            overflow: 'hidden', whiteSpace: 'nowrap' }}>
            <HardDrive size={11} style={{ flex: 'none' }} /> {dirs?.current ?? (busy ? '加载中…' : '…')}
            <span style={{ marginLeft: 'auto', flex: 'none', opacity: 0.7 }}>点目录进入 · <b>✓</b> 选定</span>
          </div>
          {dirs && dirs.parent !== '' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6,
              cursor: 'pointer', fontSize: 13, opacity: 0.75 }}
              onClick={() => void load(dirs.parent)}
              onMouseEnter={e2 => (e2.currentTarget as HTMLElement).style.background = 'var(--surface-1)'}
              onMouseLeave={e2 => (e2.currentTarget as HTMLElement).style.background = ''}>
              <HardDrive size={13} style={{ flex: 'none' }} /> .. 上级
            </div>
          )}
          {dirs && (() => {
            // 盘符根：其他盘与当前盘的目录分节展示，不混在一列
            const isDrive = (e: { name: string }) => /^[a-z]:$/i.test(e.name);
            const drivesList = dirs.entries.filter(e => isDrive(e));
            const folders = dirs.entries.filter(e => !isDrive(e));
            const section = (text: string, key: string) => (
              <div key={key} className="meta" style={{ fontSize: 11, margin: '7px 4px 3px', display: 'flex', alignItems: 'center', gap: 6, opacity: 0.75 }}>
                {text}
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
            );
            return (<>
              {drivesList.length > 0 && section('其他磁盘', 'sec-drives')}
              {drivesList.map(e => row(e.name, e.path, e.path, counts?.(e.path)))}
              {drivesList.length > 0 && folders.length > 0 && section('当前盘目录', 'sec-folders')}
              {folders.map(e => row(e.name, e.path, e.path, counts?.(e.path)))}
            </>);
          })()}
          {dirs && (
            <div className="fchip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, margin: '6px 4px 2px' }}
              onClick={() => { onChange(dirs.current); setOpen(false); }}>
              <Check size={12} /> 选择此目录（{dirs.current.split(/[\\/]/).pop() || dirs.current}）
            </div>
          )}
          {error && <div className="error" style={{ fontSize: 11, padding: 4 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
