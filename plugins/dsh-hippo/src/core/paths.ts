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

/** 当前生效的数据目录。运行时读 env（不是模块加载时快照）——测试在
 * 进程中途切换 HIPPO_DATA_DIR 也能生效；生产路径行为不变。 */
export function dataDir(): string {
  return process.env.HIPPO_DATA_DIR
    ? path.resolve(process.env.HIPPO_DATA_DIR)
    : path.join(os.homedir(), '.hippo');
}

export function ensureAppDir(): void {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function appPath(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
}
