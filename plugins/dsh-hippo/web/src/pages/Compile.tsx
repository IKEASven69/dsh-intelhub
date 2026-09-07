import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentIcon, agentLabel } from '../components/AgentIcon';
import FolderPicker from '../components/FolderPicker';
import { api } from '../api';
import GradientText from '../components/anim/GradientText';
import FadeIn from '../components/anim/FadeIn';

type TargetOpt = 'agents-md' | 'claude-md' | 'cursor' | 'copilot' | 'json' | 'all';

/** 每个目标的产出位置说明（空态与预览头共用）。 */
const DEST: Partial<Record<TargetOpt, string>> = {
  'agents-md': 'AGENTS.md — Codex / opencode 等自动加载',
  'claude-md': 'CLAUDE.md — Claude Code 自动加载',
  'cursor': '.cursor/rules/hippo-*.mdc — Cursor 自动加载',
  'copilot': '.github/copilot-instructions.md — Copilot 自动注入',
  'json': 'hippo-context.json — 程序化消费(MCP/脚本)',
};

export default function CompilePage() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<TargetOpt>('agents-md');
  const [project, setProject] = useState('');
  const [outDir, setOutDir] = useState('');
  const [indexMode, setIndexMode] = useState(false);
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [written, setWritten] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const runPreview = async () => {
    setLoading(true); setError(''); setPreview(null); setWritten(null); setMemoryCount(null);
    try {
      const r = await api.compilePreview({ target, project: project || undefined, indexMode, ...(outDir.trim() ? { outDir: outDir.trim() } : {}) });
      setPreview(r.preview); setMemoryCount(r.memoryCount);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  // 进页即出预览——用户不用猜"先点什么"
  useEffect(() => { void runPreview(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const writeFiles = async () => {
    setLoading(true); setError(''); setWritten(null);
    try {
      const r = await api.compile({ target, project: project || undefined, indexMode, ...(outDir.trim() ? { outDir: outDir.trim() } : {}) });
      setWritten(r.files); setMemoryCount(r.memoryCount);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  const targetOpts: { val: TargetOpt; label: string }[] = [
    { val: 'agents-md', label: t('compile.targetAgentsMd') },
    { val: 'claude-md', label: t('compile.targetClaudeMd') },
    { val: 'cursor', label: t('compile.targetCursor') },
    { val: 'copilot', label: 'Copilot' },
    { val: 'json', label: 'JSON' },
    { val: 'all', label: t('compile.targetAll') },
  ];

  return (
    <FadeIn>
      <h2><GradientText>{t('compile.title')}</GradientText></h2>
      <p className="sub">{t('compile.subtitle')}</p>

      {/* 目标 + 项目 + 输出路径 */}
      <div className="toolbar" style={{ marginTop: 16 }}>
        <span className="label">{t('compile.target')}</span>
        <select value={target} onChange={e => setTarget(e.target.value as TargetOpt)} style={{ width: 200 }}>
          {targetOpts.map(o => <option key={o.val} value={o.val}>{o.label}</option>)}
        </select>
        <span className="label">{t('compile.project')}</span>
        <input type="text" placeholder={t('compile.projectPlaceholder')} value={project}
          onChange={e => setProject(e.target.value)} style={{ width: 160 }} />
        <label title="文件里只放每条记忆的一行索引，正文靠 memory_recall 按需取——记忆多时大幅省 token" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={indexMode} onChange={e => setIndexMode(e.target.checked)} />
          索引式
        </label>
        <FolderPicker value={outDir} onChange={setOutDir} />
        <button className="primary" onClick={runPreview} disabled={loading}>
          {loading ? '…' : t('compile.generatePreview')}
        </button>
      </div>

      {/* agent / 项目 chips */}
      <div className="chips" style={{ gap: 5, marginTop: 14, marginBottom: 8 }}>
        <span className="fgroup">AGENT</span>
        <button className={`fchip${project === '' ? ' on' : ''}`} onClick={() => setProject('')}>全部</button>
        {['claude-code', 'codex', 'opencode', 'zcode', 'pi'].map(a => (
          <button key={a} className={`fchip${project === a ? ' on' : ''}`} onClick={() => setProject(project === a ? '' : a)}>
            <AgentIcon agent={a} size={13} /> {agentLabel(a)}
          </button>
        ))}
      </div>

      {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}

      {memoryCount !== null && (
        <div className="muted" style={{ fontSize: 12, margin: '12px 0 4px' }}>
          {t('compile.memoryCount', { count: memoryCount })}
        </div>
      )}

      {/* 空态：说明编译产物是什么、落到哪 */}
      {!preview && !loading && !error && (
        <div className="card" style={{ marginTop: 16, padding: '18px 20px' }}>
          <div className="text" style={{ fontWeight: 600, marginBottom: 8 }}>{t('compile.title')} → {t('compile.emptyWhat')}</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 2 }}>
            {Object.entries(DEST).map(([k, v]) => (
              <div key={k}><code style={{ fontSize: 11.5 }}>{k}</code> — {v}</div>
            ))}
          </div>
        </div>
      )}

      {preview && (
        <>
          <div className="toolbar" style={{ marginTop: 18, marginBottom: 4 }}>
            <span className="label">{t('compile.preview')}</span>
            <span style={{ flex: 1 }} />
            <button className="primary" onClick={writeFiles} disabled={loading}>{t('compile.writeFiles')}</button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>{t('compile.previewHint')}</div>
          <div style={{ display: 'grid', gap: 22 }}>
            {Object.entries(preview).map(([filename, content]) => (
              <div key={filename}>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5, color: 'var(--primary)', marginBottom: 6, fontWeight: 600 }}>
                  {filename}
                </div>
                <pre style={{
                  background: 'var(--surface-1)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: '14px 16px', fontSize: 12.5, lineHeight: 1.7,
                  maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  margin: 0, boxShadow: 'var(--shadow-sm)',
                }}>{content}</pre>
              </div>
            ))}
          </div>
        </>
      )}

      {written && (
        <div className="card" style={{ borderColor: 'var(--s3)', marginTop: 18 }}>
          <div className="text">{t('compile.written', { count: written.length })}</div>
          <div className="steps" style={{ marginTop: 6 }}>{written.map(f => '• ' + f).join('\n')}</div>
        </div>
      )}
    </FadeIn>
  );
}
