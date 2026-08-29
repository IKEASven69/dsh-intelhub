/**
 * 竞品迁移导入（P2）：通用 JSON/JSONL 映射器。
 *
 * 自动识别常见字段名（Mem0 / hippo-memory / MIF / PAM / 任意工具的导出）：
 * - 正文：text / content / body / memory / value
 * - 类型：type / category / kind（映射到 hippo 四类型）
 * - 项目：project / user_id / namespace / scope / app_id
 * - Agent：agent / source / provider
 *
 * 不认识的字段忽略，识别不出的行跳过（报告统计）。幂等：语义去重三档。
 */
import type { MemoryEngine } from './memory.js';

export interface ImportPreview {
  totalLines: number;
  recognized: number;
  skipped: number;
  candidates: Array<{ text: string; type: string; project: string; agent: string }>;
  error?: string;
}

export interface ImportResult {
  created: number;
  reinforced: number;
  maybe: number;
  skipped: number;
  error?: string;
}

// 字段别名 → hippo 字段
const TEXT_KEYS = ['text', 'content', 'body', 'memory', 'value', 'message'];
const TYPE_KEYS = ['type', 'category', 'kind', 'memory_type'];
const PROJECT_KEYS = ['project', 'user_id', 'namespace', 'scope', 'app_id', 'agent_id', 'collection'];
const AGENT_KEYS = ['agent', 'source', 'provider', 'origin'];

// 竞品类型 → hippo 类型
const TYPE_MAP: Record<string, string> = {
  // hippo 原生
  fact: 'fact', decision: 'decision', lesson: 'lesson', preference: 'preference',
  // MIF
  observation: 'fact', learning: 'lesson', error: 'lesson', context: 'fact',
  conversation: 'fact',
  // Mem0
  semantic: 'fact', episodic: 'fact', procedural: 'lesson', working: 'fact',
  // PAM
  note: 'fact', insight: 'fact',
  // 通用
  knowledge: 'fact', experience: 'lesson', rule: 'decision', habit: 'preference',
};

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/** 解析导入文件 → 候选列表（预览）。支持 JSON Array / JSONL / 单条 JSON。 */
export function parseImport(raw: string, defaultProject = 'global'): ImportPreview {
  const preview: ImportPreview = { totalLines: 0, recognized: 0, skipped: 0, candidates: [] };

  let items: unknown[] = [];
  const trimmed = raw.trim();

  if (trimmed.startsWith('[')) {
    // JSON Array（Mem0 导出格式）
    try {
      items = JSON.parse(trimmed) as unknown[];
    } catch {
      preview.error = 'JSON Array 解析失败';
      return preview;
    }
  } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    // 单条 JSON 或 {memories: [...]} 包装
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (Array.isArray(obj.memories)) items = obj.memories;
      else if (Array.isArray(obj.data)) items = obj.data;
      else if (Array.isArray(obj.results)) items = obj.results;
      else items = [obj];
    } catch {
      preview.error = 'JSON 解析失败';
      return preview;
    }
  } else {
    // JSONL（逐行）
    items = trimmed.split('\n').filter(l => l.trim() !== '').map(l => {
      try { return JSON.parse(l); } catch { return null; }
    });
  }

  preview.totalLines = items.length;

  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      preview.skipped += 1;
      continue;
    }
    const obj = item as Record<string, unknown>;
    const text = pick(obj, TEXT_KEYS);
    if (text === '') {
      preview.skipped += 1;
      continue;
    }
    const rawType = pick(obj, TYPE_KEYS).toLowerCase();
    const type = TYPE_MAP[rawType] ?? 'fact';
    const project = pick(obj, PROJECT_KEYS) || defaultProject;
    const agent = pick(obj, AGENT_KEYS) || 'import';
    preview.candidates.push({ text, type, project, agent });
    preview.recognized += 1;
  }

  // 截断预览显示
  return preview;
}

/** 执行导入（走去重三档）。 */
export async function executeImport(
  engine: MemoryEngine,
  candidates: Array<{ text: string; type: string; project: string; agent: string }>,
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, reinforced: 0, maybe: 0, skipped: 0 };
  for (const c of candidates) {
    try {
      const r = await engine.remember(c.text, { type: c.type, project: c.project, agent: c.agent });
      if (r.status === 'created') result.created += 1;
      else if (r.status === 'reinforced') result.reinforced += 1;
      else result.skipped += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}
