/**
 * 记忆存储 —— 现役实现是 ZvecStore（@zvec/zvec：proxima 向量索引 +
 * rocksdb FTS），本文件只保留路径工具与再导出。
 *
 * 历史：最初是 SQLite 存储（memories.db + FTS5 + sqlite-vec vec0），
 * v0.1.9 起切换到 zvec；旧 SqliteStore 实现已随生态稳定删除，旧库文件
 * memories.db 的诊断/迁移由 doctor 命令承接（只读 better-sqlite3，
 * 不在引擎 import 链上）。better-sqlite3 仍是正当依赖——会话索引
 * sessions.db（FTS5 trigram 中文搜索）和 zcode 数据源读取用它。
 */
import * as os from 'node:os';
import * as path from 'node:path';

/** Raised when the configured embedding model's dim disagrees with the dim
 * of the vectors already on disk (embedding model switched). The message
 * guides through the export -> re-embed -> import migration path. */
export class EmbedModelMismatch extends Error {}

export function dataDir(): string {
  return process.env.HIPPO_DATA_DIR ?? path.join(os.homedir(), '.hippo');
}

export { ZvecStore, EmbedModelMismatch as ZvecEmbedModelMismatch } from './zvec-store.js';
