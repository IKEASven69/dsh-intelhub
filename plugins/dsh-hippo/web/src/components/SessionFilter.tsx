/**
 * 共享筛选栏（统一设计模式）：agent chips + 项目 chips + 搜索 + 最近会话列表。
 * Sessions / Distill / Compile 等页面复用——各自只处理选中后的特有逻辑。
 */
import { useEffect, useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { api, workspaceOf, type SessionListItem } from '../api';
import { AgentIcon, agentLabel } from './AgentIcon';

export interface SessionFilter {
  agent: string
  project: string
  workspace: string
  query: string
}

export function useSessionFilter() {
  const [all, setAll] = useState<SessionListItem[]>([]);
  const [filter, setFilter] = useState<SessionFilter>({ agent: '', project: '', workspace: '', query: '' });

  useEffect(() => {
    void api.listSessions({ limit: 500 }).then(r => setAll(r.sessions)).catch(() => {});
  }, []);

  const agents = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of all) m.set(s.agent, (m.get(s.agent) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  const workspaces = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of all) {
      const w = workspaceOf(s.cwd) || '（无路径）';
      m.set(w, (m.get(w) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  const projects = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of all) {
      if (filter.agent !== '' && s.agent !== filter.agent) continue;
      if (filter.workspace !== '' && (workspaceOf(s.cwd) || '（无路径）') !== filter.workspace) continue;
      m.set(s.project, (m.get(s.project) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all, filter.agent, filter.workspace]);

  const filtered = useMemo(() => all.filter(s =>
    (filter.agent === '' || s.agent === filter.agent) &&
    (filter.workspace === '' || (workspaceOf(s.cwd) || '（无路径）') === filter.workspace) &&
    (filter.project === '' || s.project === filter.project)
  ), [all, filter]);

  return { all, filtered, filter, setFilter, agents, workspaces, projects };
}

/** 渲染统一的筛选 chips（agent → 工作区 → 项目）。 */
export function SessionFilterChips({ filter, setFilter, agents, workspaces, projects }: {
  filter: SessionFilter
  setFilter: (f: SessionFilter) => void
  agents: [string, number][]
  workspaces: [string, number][]
  projects: [string, number][]
}) {
  return (
    <>
      <div className="chips" style={{ gap: 5 }}>
        <span className="fgroup">AGENT</span>
        <button className={`fchip${filter.agent === '' ? ' on' : ''}`}
          onClick={() => setFilter({ ...filter, agent: '', workspace: '', project: '' })}>全部</button>
        {agents.map(([a, n]) => (
          <button key={a} className={`fchip${filter.agent === a ? ' on' : ''}`}
            onClick={() => setFilter({ ...filter, agent: filter.agent === a ? '' : a, workspace: '', project: '' })}>
            <AgentIcon agent={a} size={13} /> {agentLabel(a)} <span className="fn">{n}</span>
          </button>
        ))}
      </div>
      {filter.agent !== '' && workspaces.length > 1 && (
        <div className="chips" style={{ gap: 5, marginTop: 6 }}>
          <span className="fgroup">工作区</span>
          <button className={`fchip${filter.workspace === '' ? ' on' : ''}`}
            onClick={() => setFilter({ ...filter, workspace: '', project: '' })}>全部</button>
          {workspaces.slice(0, 6).map(([w, n]) => (
            <button key={w} className={`fchip${filter.workspace === w ? ' on' : ''}`}
              onClick={() => setFilter({ ...filter, workspace: filter.workspace === w ? '' : w, project: '' })}>
              {w} <span className="fn">{n}</span>
            </button>
          ))}
        </div>
      )}
      {(filter.workspace !== '' || filter.agent !== '') && projects.length > 1 && (
        <div className="chips" style={{ gap: 5, marginTop: 6 }}>
          <span className="fgroup">项目</span>
          <button className={`fchip${filter.project === '' ? ' on' : ''}`}
            onClick={() => setFilter({ ...filter, project: '' })}>全部</button>
          {projects.slice(0, 12).map(([p, n]) => (
            <button key={p} className={`fchip${filter.project === p ? ' on' : ''}`}
              onClick={() => setFilter({ ...filter, project: filter.project === p ? '' : p })}>
              {p} <span className="fn">{n}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** 统一搜索框。 */
export function SessionSearchBox({ value, onChange, onSubmit }: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
}) {
  return (
    <div className="filter-search" style={{ maxWidth: 420 }}>
      <Search size={14} className="fs-ico" />
      <input
        placeholder="搜索会话（标题/内容，支持中文）…"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSubmit(); }}
      />
    </div>
  );
}
