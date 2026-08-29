/**
 * 自动蒸馏（P0-1 · AD）：新会话零操作沉淀。设计见 docs/AUTO-DISTILL-PLAN.md。
 *
 * AD-1 本文件：搁置队列（shelved.jsonl）+ 设置（autoDistill 配置）。
 * - maybe 带候选不再"不入库即消失"：进持久化搁置队列，待复核 tab 可补入/丢弃
 * - 设置三档：off（现状）/ review（全部只进队列）/ auto（安全候选自动入库）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appPath } from '../core/paths.js';
import type { Candidate } from './distill.js';

// ── 设置 ────────────────────────────────────────────

export type AutoMode = 'off' | 'review' | 'auto';

export interface AutoDistillSettings {
  mode: AutoMode;
  /** auto 档 new 候选的置信度阈值 */
  threshold: number;
  /** 扫描间隔（分钟） */
  intervalMin: number;
  /** 只自动处理这些 agent（空=全部） */
  agents: string[];
  /** 排除这些目录前缀下的会话 */
  blockDirs: string[];
  /** 低于此轮数的会话不自动蒸馏 */
  minTurns: number;
  lastRunAt?: number;
  /** 上一轮统计（状态行显示） */
  lastRun?: { scanned: number; created: number; reinforced: number; superseded: number; shelved: number; at: number };
}

export const DEFAULT_AUTO: AutoDistillSettings = {
  mode: 'review', // 上线初期默认：只进待审队列
  threshold: 0.6, // 必须低于规则基础置信度（decision 0.7/lesson 0.6），否则 auto 模式空转
  intervalMin: 15,
  agents: [],
  blockDirs: [],
  minTurns: 5,
};

const SETTINGS_PATH = appPath('auto-distill.json');

export function loadAutoSettings(): AutoDistillSettings {
  try {
    return { ...DEFAULT_AUTO, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_AUTO };
  }
}

export function saveAutoSettings(s: AutoDistillSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf-8');
}

// ── 搁置队列 ────────────────────────────────────────

export interface ShelvedCandidate {
  candidate: Candidate;
  sessionId: string;
  sourceId: string;
  /** maybe | low-conf | review-mode | auto-pass */
  reason: string;
  createdAt: number;
}

const SHELVED_PATH = appPath('shelved.jsonl');

export function appendShelved(item: ShelvedCandidate): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.appendFileSync(SHELVED_PATH, JSON.stringify(item) + '\n', 'utf-8');
}

export function listShelved(): ShelvedCandidate[] {
  try {
    return fs.readFileSync(SHELVED_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as ShelvedCandidate);
  } catch {
    return [];
  }
}

/** 从队列取走指定条（补入库或丢弃后调用）；返回剩余数量。 */
export function takeShelved(indices: number[]): number {
  const all = listShelved();
  const drop = new Set(indices);
  const rest = all.filter((_, i) => !drop.has(i));
  fs.writeFileSync(SHELVED_PATH, rest.map(r => JSON.stringify(r)).join('\n') + (rest.length ? '\n' : ''), 'utf-8');
  return rest.length;
}
