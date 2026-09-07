/**
 * LLM 设置（模型设置页的后端）：provider/模型/密钥的持久化与调用。
 *
 * 本地优先：配置存 ~/.hippo/llm.json（明文 key——与 dsh 的
 * .credentials.yaml 同等安全级别，全链路本地）。首次加载若用户没配过，
 * 自动从 dsh 配置发现（settings.yaml 的 agent-default-model +
 * .credentials.yaml 的 key）——装过 dsh 的用户零配置即用。
 *
 * complete() 统一走 OpenAI 兼容 /chat/completions（MiniMax/ollama/自建
 * 网关都是这个形态）；思考模型正文可能在 reasoning_content（parseVerdicts
 * 侧负责 <think> 剥离）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LlmSettings {
  provider: 'minimax' | 'ollama' | 'custom';
  baseUrl: string;
  model: string;
  apiKey: string;
}

const SETTINGS_PATH = () => path.join(
  process.env.HIPPO_DATA_DIR ?? path.join(os.homedir(), '.hippo'), 'llm.json');

export const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  minimax: { baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-M3' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'gemma4:e4b' },
};

/** 从 dsh 配置发现（一次性种子；用户在设置页保存后以 llm.json 为准）。 */
function discoverFromDsh(): LlmSettings | null {
  try {
    const home = os.homedir();
    const yaml = fs.readFileSync(path.join(home, '.dsh', 'settings.yaml'), 'utf8');
    const start = yaml.indexOf('agent-default-model:');
    const section = start === -1 ? '' : yaml.slice(start, yaml.indexOf('\n\n', start) === -1 ? undefined : yaml.indexOf('\n\n', start));
    const model = section.match(/^\s+model:\s*(\S+)/m)?.[1];
    const provider = section.match(/^\s+provider:\s*(\S+)/m)?.[1];
    const cred = fs.readFileSync(path.join(home, '.dsh', '.credentials.yaml'), 'utf8');
    const key = cred.match(/[A-Z_]*API_KEY:\s*(\S+)/)?.[1];
    if (!model || !provider) return null;
    // MiniMax 官方端点;其他 provider 留 custom 由用户补 baseUrl
    const baseUrl = provider.toLowerCase().includes('minimax')
      ? PRESETS.minimax.baseUrl
      : 'http://127.0.0.1:11434/v1';
    return { provider: provider.toLowerCase().includes('minimax') ? 'minimax' : 'custom', baseUrl, model, apiKey: key ?? '' };
  } catch {
    return null;
  }
}

export function loadLlmSettings(): LlmSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')) as Partial<LlmSettings>;
    if (parsed.baseUrl && parsed.model) {
      return {
        provider: parsed.provider ?? 'custom',
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        apiKey: parsed.apiKey ?? '',
      };
    }
  } catch { /* 首次或损坏 → 发现/默认 */ }
  return discoverFromDsh() ?? { provider: 'ollama', baseUrl: PRESETS.ollama.baseUrl, model: PRESETS.ollama.model, apiKey: '' };
}

export function saveLlmSettings(s: LlmSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH()), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(s, null, 2), 'utf-8');
}

/** 掩码给前端展示（只回尾 4 位）。 */
export function maskKey(k: string): string {
  return k ? `****${k.slice(-4)}` : '';
}

/** 用当前设置调一次 chat/completions。think 模型的 reasoning 兜底在这层。 */
export async function completeWithSettings(
  system: string,
  user: string,
  opts: { timeoutMs?: number; temperature?: number } = {},
): Promise<string> {
  const s = loadLlmSettings();
  if (!s.apiKey && s.provider !== 'ollama') throw new Error('未配置 API key——请在设置页填写');
  const resp = await fetch(`${s.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: s.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 4096,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!resp.ok) throw new Error(`${s.provider} ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
  const d = (await resp.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
  const m = d.choices?.[0]?.message;
  return m?.content?.trim() !== '' ? m!.content! : (m?.reasoning_content ?? '');
}
