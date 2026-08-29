/**
 * 生活流页（life K0）：居民卡 + 频道列表 + 创建。K1 起加对话流。
 */
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, MessageSquarePlus, UserPlus } from 'lucide-react';
import FadeIn from '../components/anim/FadeIn';
import EmptyState from '../components/EmptyState';
import { api } from '../api';

interface Resident { name: string; persona: string; state: { channels: string[]; lastSpokeAt: number; chattiness: number } }
interface Channel { id: string; topic: string; members: string[]; createdAt: number }
interface Msg { seq: number; at: number; author: { kind: string; name: string }; text: string }

export default function LifePage() {
  const { t } = useTranslation();
  const [residents, setResidents] = useState<Resident[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState('');
  const [showNewResident, setShowNewResident] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  // 表单
  const [nrName, setNrName] = useState('');
  const [nrPersona, setNrPersona] = useState('');
  const [ncId, setNcId] = useState('');
  const [ncTopic, setNcTopic] = useState('');
  const [ncMembers, setNcMembers] = useState('');
  // 选中频道的消息流
  const [openCh, setOpenCh] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([api.lifeResidents(), api.lifeChannels()]);
      setResidents(r); setChannels(c); setError('');
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const loadMsgs = useCallback(async (id: string) => {
    try { setMsgs(await api.lifeMessages(id)); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { if (openCh !== null) void loadMsgs(openCh); }, [openCh, loadMsgs]);

  const createResident = async () => {
    setBusy(true);
    try { await api.lifeCreateResident(nrName, nrPersona); setNrName(''); setNrPersona(''); setShowNewResident(false); await reload(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const createChannel = async () => {
    setBusy(true);
    try {
      await api.lifeCreateChannel(ncId, ncTopic, ncMembers.split(/[,，\s]+/).filter(Boolean));
      setNcId(''); setNcTopic(''); setNcMembers(''); setShowNewChannel(false); await reload();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const send = async () => {
    if (openCh === null || input.trim() === '') return;
    setBusy(true);
    try {
      await api.lifeSendMessage(openCh, input.trim());
      setInput('');
      await loadMsgs(openCh);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const ch = channels.find(c => c.id === openCh) ?? null;

  return (
    <FadeIn>
      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h1><UserPlus size={22} style={{ verticalAlign: -4, marginRight: 8 }} />{t('life.title')}</h1>
        <span className="meta">{residents.length} 位居民 · {channels.length} 个频道</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setShowNewResident(!showNewResident)}><UserPlus size={14} style={{ verticalAlign: -2, marginRight: 4 }} />{t('life.newResident')}</button>
        <button className="btn pri" onClick={() => setShowNewChannel(!showNewChannel)}><MessageSquarePlus size={14} style={{ verticalAlign: -2, marginRight: 4 }} />{t('life.newChannel')}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {showNewResident && (
        <div className="card" style={{ margin: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="form-row">
            <input className="filter-search" style={{ maxWidth: 200 }} placeholder="名字（kebab-case，如 moli）" value={nrName} onChange={e => setNrName(e.target.value)} />
          </div>
          <textarea rows={3} placeholder="人格设定（persona）：性格/说话方式/关注什么……" value={nrPersona} onChange={e => setNrPersona(e.target.value)} />
          <div className="form-row"><button className="btn pri" disabled={busy || nrName === '' || nrPersona.trim() === ''} onClick={createResident}>创建</button></div>
        </div>
      )}
      {showNewChannel && (
        <div className="card" style={{ margin: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="form-row">
            <input className="filter-search" style={{ maxWidth: 200 }} placeholder="频道 id（kebab-case）" value={ncId} onChange={e => setNcId(e.target.value)} />
            <input className="filter-search" style={{ maxWidth: 320 }} placeholder="主题一句话" value={ncTopic} onChange={e => setNcTopic(e.target.value)} />
            <input className="filter-search" style={{ maxWidth: 260 }} placeholder="成员（逗号分隔居民名，可空）" value={ncMembers} onChange={e => setNcMembers(e.target.value)} />
          </div>
          <div className="form-row"><button className="btn pri" disabled={busy || ncId === '' || ncTopic.trim() === ''} onClick={createChannel}>创建</button></div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, marginTop: 12 }}>
        {/* 左列：居民 + 频道 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="nav-group" style={{ padding: '0 4px 6px' }}>{t('life.residents')}</div>
            {residents.map(r => (
              <div key={r.name} className="card" style={{ padding: '8px 12px', marginBottom: 6 }}>
                <b style={{ fontSize: 13 }}>{r.name}</b>
                <div className="meta" style={{ fontSize: 11 }}>话痨 {r.state.chattiness}/h · {r.state.channels.length} 频道</div>
              </div>
            ))}
            {residents.length === 0 && <div className="meta">{t('life.noResidents')}</div>}
          </div>
          <div>
            <div className="nav-group" style={{ padding: '0 4px 6px' }}>{t('life.channels')}</div>
            {channels.map(c => (
              <button key={c.id} className={`card clickable${openCh === c.id ? ' active' : ''}`} style={{ padding: '8px 12px', marginBottom: 6, width: '100%', textAlign: 'left' }} onClick={() => setOpenCh(c.id)}>
                <b style={{ fontSize: 13 }}>#{c.id}</b>
                <div className="meta" style={{ fontSize: 11 }}>{c.topic.slice(0, 24)}{c.members.length > 0 ? ` · ${c.members.join('、')}` : ''}</div>
              </button>
            ))}
            {channels.length === 0 && <div className="meta">{t('life.noChannels')}</div>}
          </div>
        </div>

        {/* 右列：选中频道消息流 */}
        <div>
          {ch !== null ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 220px)' }}>
              <div style={{ fontWeight: 700, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>#{ch.id} — {ch.topic}</div>
              <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 2px' }}>
                {msgs.map(m => (
                  <div key={m.seq} style={{ display: 'flex', gap: 8 }}>
                    <div style={{ width: 3, borderRadius: 2, flex: 'none', background: m.author.kind === 'resident' ? 'var(--s1)' : 'var(--s2)' }} />
                    <div>
                      <div className="meta" style={{ fontSize: 10.5, fontWeight: 700 }}>{m.author.name}{m.author.kind === 'resident' ? ' 🏠' : ''}</div>
                      <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{m.text}</div>
                    </div>
                  </div>
                ))}
                {msgs.length === 0 && <div className="meta">{t('life.emptyCh')}</div>}
              </div>
              <div className="form-row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <input className="filter-search" style={{ maxWidth: 'none' }} placeholder={t('life.saySomething')} value={input}
                  onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} />
                <button className="btn pri" disabled={busy || input.trim() === ''} onClick={send}>{t('life.send')}</button>
              </div>
            </div>
          ) : (
            <EmptyState icon={MessageSquare} title="选择一个频道" hint="频道是居民的对话空间。创建频道后可以召唤居民进来聊天。" />
          )}
        </div>
      </div>
    </FadeIn>
  );
}
