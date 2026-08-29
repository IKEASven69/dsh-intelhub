/**
 * Telegram Bot（P2）：手机端白嫖整个 hippo 引擎。
 *
 * 纯 fetch + setInterval 长轮询，零框架。LLM 走 ollama 本地。
 * 命令：
 *   直接发消息 → 召回相关记忆 + LLM 生成回复
 *   /remember <text> → 直接入库
 *   /recall <query> → 语义搜索
 *   /status → 引擎状态
 *
 * 启动：hippo serve --telegram <token> [--ollama http://127.0.0.1:11434]
 */
import { withEngine } from './engine-holder.js';
import { loadAutoSettings, listShelved } from './auto-distill.js';

const TG_API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_S = 25; // 代理可能截 50s，25 安全

interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { first_name: string };
    text?: string;
  };
}

export interface TelegramConfig {
  token: string;
  ollamaUrl?: string; // 默认 http://127.0.0.1:11434
  ollamaModel?: string; // 默认 gemma4:e4b
}

async function tgCall(token: string, method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetch(`${TG_API}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return resp.json() as Promise<Record<string, unknown>>;
}

async function tgSend(token: string, chatId: number, text: string): Promise<void> {
  // Telegram 消息上限 4096 字符
  for (let i = 0; i < text.length; i += 4000) {
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: text.slice(i, i + 4000),
      parse_mode: 'Markdown',
    }).catch(() => {}); // 发送失败不阻断
  }
}

async function ollamaChat(config: TelegramConfig, system: string, user: string): Promise<string> {
  const url = `${config.ollamaUrl ?? 'http://127.0.0.1:11434'}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel ?? 'gemma4:e4b',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 2048,
    }),
  });
  const d = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return d.choices?.[0]?.message?.content ?? '……';
}

async function handleMessage(config: TelegramConfig, text: string, chatId: number, userName: string): Promise<string> {
  const trimmed = text.trim();

  // /remember
  if (trimmed.startsWith('/remember ')) {
    const memory = trimmed.slice('/remember '.length).trim();
    if (memory === '') return '用法：/remember <要记住的内容>';
    return withEngine(async ({ engine }) => {
      const r = await engine.remember(memory, { type: 'fact', project: 'telegram', agent: 'telegram' });
      return r.status === 'created' ? '✓ 已记住' : `✓ 已强化（第 ${r.strength ?? 2} 次提及）`;
    }).catch(e => `写入失败：${(e as Error).message}`);
  }

  // /recall
  if (trimmed.startsWith('/recall ')) {
    const query = trimmed.slice('/recall '.length).trim();
    if (query === '') return '用法：/recall <查询>';
    return withEngine(async ({ engine }) => {
      const hits = await engine.recall(query, { project: 'telegram', limit: 5 });
      if (hits.length === 0) return '没有找到相关记忆';
      return hits.map((h, i) => `${i + 1}. [${h.type}] ${h.text.slice(0, 80)}`).join('\n');
    }).catch(e => `查询失败：${(e as Error).message}`);
  }

  // /status
  if (trimmed === '/status') {
    const st = loadAutoSettings();
    const shelved = listShelved().length;
    return `hippo 引擎状态：\n· 自动蒸馏：${st.mode}\n· 阈值：${st.threshold}\n· 待审队列：${shelved} 条`;
  }

  // 普通消息 → 召回 + LLM 回复
  const memories = await withEngine(async ({ engine }) => {
    const hits = await engine.recall(trimmed, { project: 'telegram', limit: 3 });
    return hits.map(h => `[${h.type}] ${h.text.slice(0, 80)}`).join('\n');
  }).catch(() => '');

  const system = '你是用户的个人 AI 助手（hippo）。你拥有用户的记忆库。用简洁中文回复（2-5 句）。' +
    (memories !== '' ? `\n\n--- 相关记忆 ---\n${memories}` : '');

  try {
    return await ollamaChat(config, system, trimmed);
  } catch {
    return `LLM 调用失败（ollama 未启动？）。直接搜索结果：\n${memories !== '' ? memories : '无相关记忆'}`;
  }
}

/** 启动 Telegram Bot 长轮询循环。返回停止函数。 */
export function startTelegramBot(config: TelegramConfig): () => void {
  let offset = 0;
  let running = true;

  console.log(`[telegram] Bot 启动（token=...${config.token.slice(-4)}，ollama=${config.ollamaUrl ?? '默认'}）`);

  const poll = async (): Promise<void> => {
    while (running) {
      try {
        const resp = await fetch(`${TG_API}${config.token}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}`, {
          signal: AbortSignal.timeout((POLL_TIMEOUT_S + 5) * 1000),
        });
        const d = (await resp.json()) as { ok: boolean; result?: TgUpdate[] };
        if (!d.ok || !d.result) continue;

        for (const update of d.result) {
          offset = update.update_id + 1;
          if (!update.message?.text) continue;
          const { chat, from, text } = update.message;
          console.log(`[telegram] ${from?.first_name ?? '用户'}: ${text.slice(0, 50)}`);
          const reply = await handleMessage(config, text, chat.id, from?.first_name ?? '用户');
          await tgSend(config.token, chat.id, reply);
        }
      } catch {
        // 网络错误/超时→等 3 秒重试
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  };

  void poll();

  return () => {
    running = false;
    console.log('[telegram] Bot 停止');
  };
}
