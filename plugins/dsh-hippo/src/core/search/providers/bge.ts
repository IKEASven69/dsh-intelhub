/**
 * BGE 嵌入 provider —— 中文质量优先的本地实现。
 *
 * 模型：Xenova/bge-m3（1024 维，多语言，中英文质量都强）
 * 量化后约 600MB+，首次使用从 hf-mirror.com 下载。
 *
 * 实测对比（相似度越高越好，>0.1 差距视为区分良好）：
 *   - MiniLM "数据库锁" vs 真相关文档：噪声级
 *   - bge-m3 同查询：0.769（区分良好）
 *
 * 比 MiniLM 重（模型大、每条嵌入慢约 3 倍、索引体积 2.7x），但中文场景
 * 这是必须的代价。MVP 选它作为默认，因为 agent transcript 中英混杂。
 *
 * 网络策略同 Xenova：默认 hf-mirror.com，HF_ENDPOINT 可覆盖。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbedProvider } from '../types.js';

const MODEL_ID = 'Xenova/bge-m3';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise;

  if (!process.env.HF_ENDPOINT) {
    env.remoteHost = 'https://hf-mirror.com';
  } else {
    env.remoteHost = process.env.HF_ENDPOINT;
  }
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  // 模型缓存放 ~/.hippo/models/transformers——node_modules 会随 npm/pnpm 重装被清空
  // （2026-08-22 踩坑：2.2GB 缓存随包重装丢失，嵌入静默变成重下载挂起）。
  // HIPPO_TRANSFORMERS_CACHE 可覆盖；HF_HUB_OFFLINE=1 强制纯离线。
  const cacheDir = process.env.HIPPO_TRANSFORMERS_CACHE ?? join(homedir(), '.hippo', 'models', 'transformers');
  mkdirSync(cacheDir, { recursive: true });
  env.cacheDir = cacheDir;

  extractorPromise = pipeline('feature-extraction', MODEL_ID) as Promise<FeatureExtractionPipeline>;
  return extractorPromise;
}

export const BgeM3Provider: EmbedProvider = {
  name: 'bge-m3',
  dim: 1024,

  async embed(text: string): Promise<Float32Array> {
    const extractor = await getExtractor();
    // BGE 系列：mean pooling + L2 normalize（跟 MiniLM 一样的后处理）
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  },
};
