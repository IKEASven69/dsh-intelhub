/**
 * Claude Code transcript 解析 —— hippo distill.py 的 TS 移植。
 *
 * 与 hippo `entry_to_turns` / `parse_jsonl` 逐行等价：
 * 一条 assistant 消息的多个 content block 拆成多个 Turn
 * （text / thinking / tool_use），user 消息里的 tool_result block
 * 变成带 failed 标记的 tool turn。
 */

// ── 类型 ──────────────────────────────────────────

/** 对话的一个最小单元（从一行 transcript 提取） */
export interface Turn {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  cwd: string;
  ts: string;
  toolName: string;
  toolFailed: boolean;
  model: string;
}

export function makeTurn(partial: Partial<Turn> & Pick<Turn, 'role' | 'text'>): Turn {
  return {
    cwd: '',
    ts: '',
    toolName: '',
    toolFailed: false,
    model: '',
    ...partial,
  };
}

type Entry = Record<string, unknown>;
type Block = Record<string, unknown>;

// ── JSONL 解析 ────────────────────────────────────

/** 逐行解析 transcript JSONL；非 JSON / 空行静默跳过（与 Python 版一致） */
export function* parseJsonl(text: string): Generator<Entry> {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line) as Entry;
    } catch {
      continue;
    }
  }
}

// ── content 提取 ──────────────────────────────────

/** 把 Claude message.content（字符串或 block 数组）压平为纯文本 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Block[])
      .filter(b => b && typeof b === 'object' && b.type === 'text')
      .map(b => (typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

/** tool_use 的人类可读一行摘要（对应 Python _summarize_tool_call） */
export function summarizeToolCall(name: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return name;
  const inp = input as Record<string, unknown>;

  const cmd = inp.command;
  if (typeof cmd === 'string') {
    const v = cmd.replace(/\s+/g, ' ').trim();
    return v.slice(0, 100) + (v.length > 100 ? '…' : '');
  }
  for (const key of ['file_path', 'path', 'filePath']) {
    const v = inp[key];
    if (typeof v === 'string') return `${name}: ${v}`;
  }
  // fallback：第一个字符串值参数
  for (const v of Object.values(inp)) {
    if (typeof v === 'string') {
      const s = v.replace(/\s+/g, ' ').trim();
      return `${name}: ${s.slice(0, 80)}` + (s.length > 80 ? '…' : '');
    }
  }
  return name;
}

// ── entry → turns ─────────────────────────────────

/** 把一行 transcript JSON 拆成 Turn 列表（逐行等价 hippo entry_to_turns） */
export function entryToTurns(entry: Entry): Turn[] {
  const turns: Turn[] = [];
  const etype = entry.type;
  const msg = (entry.message ?? {}) as Record<string, unknown>;
  const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : '';
  const model = typeof msg.model === 'string' ? msg.model : '';
  const content = msg.content;

  if (etype === 'user' && msg.role === 'user') {
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content as Block[]) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          const rc = extractTextContent(block.content);
          turns.push(makeTurn({
            role: 'tool', text: rc, cwd, ts,
            toolFailed: Boolean(block.is_error),
          }));
        } else if (block.type === 'text') {
          textParts.push(typeof block.text === 'string' ? block.text : '');
        }
      }
      const text = textParts.join('\n').trim();
      if (text) turns.push(makeTurn({ role: 'user', text, cwd, ts }));
    } else if (typeof content === 'string') {
      const text = content.trim();
      if (text) turns.push(makeTurn({ role: 'user', text, cwd, ts }));
    }
    return turns;
  }

  if (etype === 'assistant' && msg.role === 'assistant') {
    if (typeof content === 'string') {
      turns.push(makeTurn({ role: 'assistant', text: content, cwd, ts, model }));
    } else if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (!block || typeof block !== 'object') continue;
        const btype = block.type;
        if (btype === 'text' && typeof block.text === 'string' && block.text.trim()) {
          turns.push(makeTurn({ role: 'assistant', text: block.text, cwd, ts, model }));
        } else if (btype === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          turns.push(makeTurn({ role: 'assistant', text: '[thinking] ' + block.thinking, cwd, ts, model }));
        } else if (btype === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : '';
          turns.push(makeTurn({
            role: 'assistant', cwd, ts, model,
            text: summarizeToolCall(name, block.input),
            toolName: name,
          }));
        }
      }
    }
  }
  return turns;
}

/** 从 transcript 的 cwd 推导项目名（取最后一段路径；空 → global） */
export function cwdToProject(cwd: string): string {
  if (!cwd) return 'global';
  const segs = cwd.trim().replace(/[\\/]+$/, '').split(/[\\/]+/).filter(s => s);
  return segs.length ? segs[segs.length - 1] : 'global';
}
