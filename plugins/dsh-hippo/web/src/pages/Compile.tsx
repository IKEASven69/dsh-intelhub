import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentIcon, agentLabel } from '../components/AgentIcon';
import FolderPicker from '../components/FolderPicker';
import { api } from '../api';
import GradientText from '../components/anim/GradientText';
import FadeIn from '../components/anim/FadeIn';

type TargetOpt = 'agents-md' | 'claude-md' | 'cursor' | 'copilot' | 'json' | 'all';

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
      <div className="toolbar">
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

      {/* agent / 项目 chips（统一设计模式——从记忆库按来源 agent 筛选再编译） */}
      <div className="chips" style={{ gap: 5, marginTop: 10 }}>
        <span className="fgroup">AGENT</span>
        <button className={`fchip${project === '' ? ' on' : ''}`} onClick={() => setProject('')}>全部</button>
        {['claude-code', 'codex', 'opencode', 'zcode', 'pi'].map(a => (
          <button key={a} className={`fchip${project === a ? ' on' : ''}`} onClick={() => setProject(project === a ? '' : a)}>
            <AgentIcon agent={a} size={13} /> {agentLabel(a)}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {memoryCount !== null && (
        <div className="muted" style={{ fontSize: 12, margin: '8px 0' }}>
          {t('compile.memoryCount', { count: memoryCount })}
        </div>
      )}

      {preview && (
        <>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <span className="label">{t('compile.preview')}</span>
            <span style={{ flex: 1 }} />
            <button className="primary" onClick={writeFiles} disabled={loading}>{t('compile.writeFiles')}</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{t('compile.previewHint')}</div>
          {Object.entries(preview).map(([filename, content]) => (
            <div key={filename} style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--primary)', marginBottom: 4 }}>
                {filename}
              </div>
              <pre style={{
                background: 'var(--surface-1)', border: '1px solid var(--border)',
                borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.5,
                maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>{content}</pre>
            </div>
          ))}
        </>
      )}

      {written && (
        <div className="card" style={{ borderColor: 'var(--s3)', marginTop: 14 }}>
          <div className="text">{t('compile.written', { count: written.length })}</div>
          <div className="steps" style={{ marginTop: 6 }}>{written.map(f => '• ' + f).join('\n')}</div>
        </div>
      )}
    </FadeIn>
  );
}
