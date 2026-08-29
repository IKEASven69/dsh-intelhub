/**
 * 语义搜索配置 —— 持久化到 ~/.hippo/config.json。
 *
 * 让用户能切换 provider（默认 bge-m3，可配 xenova/openai）。
 * 配置文件不跨设备同步（含 API key），各设备独立。
 */
import * as fs from 'node:fs';
import { ensureAppDir, appPath } from '../paths.js';
import { DEFAULT_PROVIDER_CONFIG, type ProviderConfig } from './types.js';

const CONFIG_PATH = appPath('config.json');

let cached: ProviderConfig | null = null;

export function loadConfig(): ProviderConfig {
  if (cached) return cached;
  ensureAppDir();

  if (!fs.existsSync(CONFIG_PATH)) {
    cached = { ...DEFAULT_PROVIDER_CONFIG };
    return cached;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<ProviderConfig>;
    cached = { ...DEFAULT_PROVIDER_CONFIG, ...raw };
    return cached;
  } catch {
    cached = { ...DEFAULT_PROVIDER_CONFIG };
    return cached;
  }
}

export function saveConfig(cfg: ProviderConfig): void {
  ensureAppDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  cached = cfg;
}

export const CONFIG_FILE = CONFIG_PATH;
