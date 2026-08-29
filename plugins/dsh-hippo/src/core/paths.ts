/**
 * 数据目录管理 —— hippo-skills 的文件系统位置都在这里定义。
 *
 * 数据目录：~/.hippo/（HIPPO_DATA_DIR 可覆盖）
 *   - memories.db     SQLite 记忆库（memories + FTS5 + vec_memories）
 *   - config.json     嵌入 provider 配置
 *   - sources/        L0 transcript blob
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export const APP_DIR = process.env.HIPPO_DATA_DIR
  ? path.resolve(process.env.HIPPO_DATA_DIR)
  : path.join(os.homedir(), '.hippo');

export function ensureAppDir(): void {
  if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });
}

export function appPath(...segments: string[]): string {
  return path.join(APP_DIR, ...segments);
}
