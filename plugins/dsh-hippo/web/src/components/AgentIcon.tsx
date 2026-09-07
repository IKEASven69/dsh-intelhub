/**
 * agent 官方品牌图标与规范显示名（大小写以各家官方写法为准）。
 * 图标资产来自 docs/icons（官方原版抓取）；zcode 暂无官方资产，用 Z 字标占位。
 * G2 会话页与既有来源标签共用这一份映射，避免各处手写大小写。
 */
import claudeIcon from '../assets/agents/claude.svg';
import codexIcon from '../assets/agents/openai.svg';
import opencodeIcon from '../assets/agents/opencode.svg';
import geminiIcon from '../assets/agents/gemini.svg';
import antigravityIcon from '../assets/agents/antigravity.ico';
import traeIcon from '../assets/agents/trae.png';

interface AgentMeta {
  /** 规范显示名（官方大小写）。 */
  label: string;
  /** 图标资源 URL；无官方资产的 agent 用 letter 标。 */
  icon?: string;
  letter?: string;
}

export const AGENT_META: Record<string, AgentMeta> = {
  'claude-code': { label: 'Claude Code', icon: claudeIcon },
  'codex': { label: 'Codex', icon: codexIcon },
  'opencode': { label: 'opencode', icon: opencodeIcon },
  'zcode': { label: 'zcode', letter: 'Z' },
  'antigravity': { label: 'Antigravity', icon: antigravityIcon },
  'trae': { label: 'Trae', icon: traeIcon },
  'gemini': { label: 'Gemini', icon: geminiIcon },
};

/**
 * 规范化来源标签："import:claude-code" → "Claude Code"，
 * "distill:opencode" → "opencode"；未知值原样返回。
 */
export function agentLabel(raw: string): string {
  const id = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  return AGENT_META[id]?.label ?? raw;
}

/** 从 "import:claude-code" 这类带前缀的标签里取 agent id；无前缀原样。 */
function agentIdOf(raw: string): string {
  return raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
}

export function AgentIcon({ agent, size = 14 }: { agent: string; size?: number }) {
  const meta = AGENT_META[agentIdOf(agent)];
  if (meta?.icon) {
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size + 6, height: size + 6, borderRadius: '50%',
          background: 'rgba(255,255,255,0.92)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.08)',
          flexShrink: 0,
        }}
      >
        <img
          src={meta.icon}
          alt={meta.label}
          width={size}
          height={size}
          style={{ width: size, height: size, borderRadius: 2, objectFit: 'contain', display: 'block' }}
        />
      </span>
    );
  }
  if (meta?.letter) {
    return (
      <span
        aria-label={meta.label}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, borderRadius: 3,
          background: 'var(--primary-soft, #eee)', color: 'var(--primary, #6d5cff)',
          fontSize: size * 0.72, fontWeight: 700, lineHeight: 1,
        }}
      >
        {meta.letter}
      </span>
    );
  }
  // 未知 agent：不渲染图标，避免误导
  return null;
}
