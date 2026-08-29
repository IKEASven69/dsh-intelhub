/**
 * 编译配置（自动化闭环）：记住用户配置过的编译目标，
 * 自动蒸馏后自动重编译——用户零操作。
 *
 * 流程：用户手动编译一次 → hippo 记住 project + outPath + target →
 * 每次自动蒸馏产生新记忆后 → 自动重编译所有已配置的项目 → AGENTS.md 始终最新。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appPath } from '../core/paths.js';

export interface CompileTarget {
  project: string;
  outPath: string;
  target: string; // 'agents-md' | 'claude-md' | 'cursor' | 'copilot'
  lastCompiledAt: number;
  lastMemoryCount: number;
}

const CONFIG_FILE = () => appPath('compile-config.json');

export function loadCompileConfig(): { targets: CompileTarget[] } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf-8'));
  } catch {
    return { targets: [] };
  }
}

export function saveCompileConfig(config: { targets: CompileTarget[] }): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2), 'utf-8');
}

/** 手动编译时调用——记住配置，下次自动蒸馏后重编。 */
export function recordCompile(project: string, outPath: string, target: string, memoryCount: number): void {
  const config = loadCompileConfig();
  const existing = config.targets.find(t => t.project === project && t.outPath === outPath);
  if (existing) {
    existing.lastCompiledAt = Date.now() / 1000;
    existing.lastMemoryCount = memoryCount;
    existing.target = target;
  } else {
    config.targets.push({
      project, outPath, target,
      lastCompiledAt: Date.now() / 1000,
      lastMemoryCount: memoryCount,
    });
  }
  saveCompileConfig(config);
}

/** 删除某个项目的编译配置。 */
export function removeCompileConfig(project: string, outPath: string): void {
  const config = loadCompileConfig();
  config.targets = config.targets.filter(t => !(t.project === project && t.outPath === outPath));
  saveCompileConfig(config);
}

/** 获取某项目的编译配置（给 GUI 显示）。 */
export function getCompileTargets(project?: string): CompileTarget[] {
  const config = loadCompileConfig();
  if (project === undefined) return config.targets;
  return config.targets.filter(t => t.project === project);
}
