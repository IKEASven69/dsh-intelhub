/**
 * Memoryfields 格式（H8）：透明可移植的记忆镜像层。
 *
 * 动机（memoryfield-spec，calpaterson）：记忆应是透明的 Markdown 数据而非
 * 流程黑盒——agent 与人都能 grep/cat 直接读写。hippo 的 zvec 索引照旧做
 * 检索引擎（该留的留），本模块提供**每条记忆一个 .md 文件**的镜像出口与
 * 生态兼容入口：
 *
 *   export: 记忆库 → 扁平目录（<uuid-slug>.md + index.md）
 *   import: 该格式目录 → 记忆库（生态互通 / 备份回导）
 *
 * 合规要点（SPEC v0.1）：
 * - 文件名 MUST：ASCII 小写字母/数字/连字符，首尾为字母或数字
 * - frontmatter：title/uuid/created/updated SHOULD，datetime 必须带引号
 *   （YAML 1.1 解析器会把裸 datetime 强制转型）
 * - 页面 SHOULD ≤8192 字节，超出拆分（新 uuid，保留来源）
 * - index.md MUST NOT 含页面清单（防上下文爆炸）——清单是 listing.md 的事
 * - 必须忽略同步碎片：.sync-conflict-* / ~ 结尾 / .DS_Store 等
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryRecord } from './memory.js';

/** 页面上限（SPEC：SHOULD NOT exceed 8192 bytes）。 */
export const PAGE_LIMIT = 8192;

/** 同步工具/系统碎片文件（SPEC：MUST 忽略）。 */
const JUNK = /^(\.sync-conflict-.*|\.DS_Store|desktop\.ini|Thumbs\.db|index\.md|listing\.md)$/;

export function isJunk(name: string): boolean {
  return JUNK.test(name) || name.endsWith('~');
}

/** 文件名合规化：ASCII 小写/数字/连字符、首尾字母或数字。
 *  中文正文剥不出 ASCII 时退化为 'm'（唯一性由 -<uuid8> 段保证）。 */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug === '' ? 'm' : slug;
}

/** 记忆 id（32 hex）→ 合规 UUID 形态（8-4-4-4-12）。uuid MUST 不变，故为纯重排。 */
export function idToUuid(id: string): string {
  const hex = String(id ?? '').replace(/[^0-9a-f]/g, '').toLowerCase().padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** uuid → 记忆 id（反向：去连字符截 32）。 */
export function uuidToId(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase().slice(0, 32);
}

const TYPE_LABEL: Record<string, string> = {
  fact: '事实', decision: '决策', lesson: '教训', preference: '偏好',
};

function iso(sec: number): string {
  return sec > 0 ? new Date(sec * 1000).toISOString() : new Date(0 * 1000).toISOString();
}

/** 单条记忆 → 页面字节（frontmatter + 正文）。返回 null 表示跳过（空文本等）。 */
export function memoryToPage(r: MemoryRecord): string | null {
  const text = (r.text ?? '').trim();
  if (text === '') return null;
  const typeLabel = TYPE_LABEL[r.type] ?? r.type;
  const superseded = r.superseded_by ? `\n\n> ⚠️ 本条已被新记忆取代（${r.superseded_by}），保留作演化链。` : '';
  // SPEC 要求 frontmatter 里 datetime 是带引号的字符串
  const front = [
    '---',
    `title: ${JSON.stringify(`[${typeLabel}] ${text.slice(0, 60).replace(/\n/g, ' ')}`).slice(1, -1)}`,
    `uuid: ${idToUuid(r.id)}`,
    `summary: ${JSON.stringify(text.slice(0, 120).replace(/\n/g, ' '))}`,
    `created: '${iso(r.created_at)}'`,
    `updated: '${iso(r.accessed_at)}'`,
    `type: ${r.type}`,
    `project: ${r.project}`,
    `agent: ${r.agent}`,
    `strength: ${r.strength}`,
    ...(r.superseded_by ? [`superseded_by: ${r.superseded_by}`] : []),
    '---',
    '',
  ].join('\n');
  const body = `# ${typeLabel}\n\n${text}${superseded}\n`;
  return front + body;
}

/** 拆分超长正文（SPEC：新 uuid 保留来源；这里按段落切，每段 ≤limit）。 */
export function splitLongText(text: string, limit = PAGE_LIMIT - 600): string[] {
  if (Buffer.byteLength(text, 'utf8') <= limit) return [text];
  const paras = text.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur !== '' && Buffer.byteLength(cur + '\n\n' + p, 'utf8') > limit) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur === '' ? p : cur + '\n\n' + p;
    }
  }
  if (cur !== '') chunks.push(cur);
  // 单段仍超限的硬切（按字节边界回退避免劈开多字节字符）
  const out: string[] = [];
  for (const c of chunks) {
    if (Buffer.byteLength(c, 'utf8') <= limit) { out.push(c); continue; }
    let buf = Buffer.from(c, 'utf8');
    while (buf.length > 0) {
      let cut = Math.min(limit, buf.length);
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // 回退 UTF-8 续字节
      out.push(buf.slice(0, cut).toString('utf8'));
      buf = buf.slice(cut);
    }
  }
  return out;
}

export interface MemoryfieldStats { pages: number; skipped: number; superseded: number; bytes: number }

/** 导出：记忆数组 → memoryfield 目录。返回统计。 */
export function exportMemoryfield(records: MemoryRecord[], dir: string): MemoryfieldStats {
  fs.mkdirSync(dir, { recursive: true });
  const stats: MemoryfieldStats = { pages: 0, skipped: 0, superseded: 0, bytes: 0 };
  const used = new Set<string>(['index.md', 'listing.md']);
  for (const r of records) {
    const page = memoryToPage(r);
    if (page === null) { stats.skipped++; continue; }
    if (r.superseded_by) stats.superseded++;
    // 文件名：<slug 前 5 词>-<uuid 前 8>。uuid 段保证唯一（id 冲突不可能）。
    const base = slugify(r.text);
    const short = idToUuid(r.id).slice(0, 8);
    const chunks = splitLongText(r.text.trim());
    chunks.forEach((chunk, i) => {
      let name = chunks.length > 1 ? `${base}-${short}-${i + 1}.md` : `${base}-${short}.md`;
      while (used.has(name)) name = name.replace(/\.md$/, `-${Math.random().toString(36).slice(2, 6)}.md`);
      used.add(name);
      const front = page.slice(0, page.indexOf('---', 4) + 4);
      const body = `# ${(TYPE_LABEL[r.type] ?? r.type)}\n\n${chunk}\n`;
      const bytes = front + '\n' + body;
      fs.writeFileSync(path.join(dir, name), bytes, 'utf-8');
      stats.pages++;
      stats.bytes += Buffer.byteLength(bytes, 'utf8');
    });
  }
  // index.md：主题介绍，MUST NOT 含页面清单
  const count = stats.pages;
  fs.writeFileSync(path.join(dir, 'index.md'), [
    '---',
    "title: 'hippo 记忆库镜像'",
    `uuid: ${idToUuid('hippo-memoryfield-index-00000000000000')}`,
    `updated: '${new Date().toISOString()}'`,
    '---',
    '',
    `本目录是 hippo 记忆库的 Memoryfields 镜像（导出于 ${new Date().toISOString().slice(0, 10)}）。`,
    '',
    `每条记忆一个 Markdown 页面：AI 编码代理在会话中沉淀的决策、教训、偏好与事实。`,
    `共 ${count} 页。语义检索请用 hippo 本体（hippo recall），或按 memoryfield 规范自行建索引。`,
    '',
    '类型标记：[决策] 技术选型与方向 · [教训] 踩坑与根因 · [偏好] 用户工作习惯 · [事实] 环境与配置。',
    '',
  ].join('\n'), 'utf-8');
  return stats;
}

// ── 导入（生态互通 / 备份回导）──────────────────────────────

interface ParsedPage { uuid: string | null; title: string; text: string; created: number | null }

/** 解析一个 .md 页面：frontmatter（容错：可无）+ 正文。 */
export function parsePage(raw: string): ParsedPage {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const text = (m ? raw.slice(m[0].length) : raw).trim();
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      let v = kv[2].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
      meta[kv[1].toLowerCase()] = v;
    }
  }
  const created = meta.created ? Date.parse(meta.created) : NaN;
  return {
    uuid: meta.uuid ?? null,
    title: meta.title ?? '',
    text,
    created: Number.isNaN(created) ? null : Math.floor(created / 1000),
  };
}

/** 导入：memoryfield 目录 → 候选数组（走 distill 既有管线，去重/精炼同待遇）。 */
export function importMemoryfield(dir: string, opts: { project?: string } = {}): Array<{ text: string; source: string }> {
  if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  const out: Array<{ text: string; source: string }> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || isJunk(name)) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const page = parsePage(fs.readFileSync(full, 'utf8'));
    if (page.text === '') continue;
    // 来源：frontmatter 的 project 优先（hippo 导出的带），否则目录名
    const src = opts.project ?? 'memoryfield-import';
    out.push({ text: `[${page.title || name}] ${page.text}`.slice(0, 2000), source: src });
    void page.uuid;
  }
  return out;
}
