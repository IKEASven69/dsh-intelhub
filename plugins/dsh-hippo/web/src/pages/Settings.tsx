import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import GradientText from '../components/anim/GradientText';
import FadeIn from '../components/anim/FadeIn';

interface LlmSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasKey: boolean;
  presets: Record<string, { baseUrl: string; model: string }>;
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const [s, setS] = useState<LlmSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState('');
  const [testResult, setTestResult] = useState('');

  useEffect(() => { api.llmSettings().then(setS).catch(e => setMsg((e as Error).message)); }, []);

  const pick = (provider: string) => {
    if (!s) return;
    const p = s.presets[provider];
    setS({ ...s, provider, ...(p ? { baseUrl: p.baseUrl, model: p.model } : {}) });
  };

  const save = async () => {
    if (!s) return;
    setSaving(true); setMsg('');
    try {
      const saved = await api.saveLlmSettings({ provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey });
      setS({ ...s, ...saved }); setMsg(t('settings.saved'));
    } catch (e) { setMsg((e as Error).message); }
    setSaving(false);
  };

  const test = async () => {
    setTesting(true); setTestResult('');
    try {
      const r = await api.testLlmSettings();
      setTestResult(r.ok ? t('settings.testOk', { ms: r.ms, sample: r.sample }) : t('settings.testFail', { error: r.error }));
    } catch (e) { setTestResult(t('settings.testFail', { error: (e as Error).message })); }
    setTesting(false);
  };

  if (!s) return <div className="empty">{t('common.loading')}</div>;

  return (
    <FadeIn>
      <h2><GradientText>{t('settings.title')}</GradientText></h2>
      <p className="sub">{t('settings.subtitle')}</p>

      <div className="card" style={{ maxWidth: 620, padding: '18px 20px', display: 'grid', gap: 14, marginTop: 16 }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="label">{t('settings.provider')}</span>
          <select value={s.provider} onChange={e => pick(e.target.value)} style={{ width: 260 }}>
            <option value="minimax">{t('settings.pMinimax')}</option>
            <option value="ollama">{t('settings.pOllama')}</option>
            <option value="custom">{t('settings.pCustom')}</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="label">{t('settings.baseUrl')}</span>
          <input type="text" value={s.baseUrl} onChange={e => setS({ ...s, baseUrl: e.target.value })} style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="label">{t('settings.model')}</span>
          <input type="text" value={s.model} onChange={e => setS({ ...s, model: e.target.value })} style={{ width: 320 }} />
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="label">{t('settings.key')}</span>
          <input type="password" value={s.apiKey} placeholder={s.hasKey ? t('settings.keyMasked') : t('settings.keyNone')}
            onChange={e => setS({ ...s, apiKey: e.target.value })} style={{ width: 380 }} autoComplete="off" />
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="primary" onClick={save} disabled={saving}>{saving ? '…' : t('settings.save')}</button>
          <button onClick={test} disabled={testing}>{testing ? t('settings.testing') : t('settings.test')}</button>
        </div>
        {msg && <div className="muted" style={{ fontSize: 12.5 }}>{msg}</div>}
        {testResult && (
          <div style={{ fontSize: 12.5, wordBreak: 'break-all', color: testResult.startsWith('✓') ? 'var(--s3)' : 'var(--danger)' }}>
            {testResult}
          </div>
        )}
      </div>
    </FadeIn>
  );
}
