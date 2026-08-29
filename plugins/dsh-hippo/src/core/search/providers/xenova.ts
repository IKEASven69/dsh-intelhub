/**
 * Xenova 本地嵌入 provider —— 离线优先的默认实现。
 *
 * 模型：Xenova/all-MiniLM-L6-v2（384 维，英文为主，中英混杂也能用）
 * 量化后约 23MB，首次使用从 HuggingFace 下载到本地缓存。
 *
 * 网络策略：默认走 hf-mirror.com 国内镜像（实测官方源在国内 TCP 被干扰）。
 *   - 环境变量 HF_ENDPOINT 可覆盖（设为 https://huggingface.co 走官方）
 *   - 模型下载后缓存到 ~/.cache/huggingface，后续完全离线
 *
 * 性能：模型实例只加载一次（重 JS 堆），后续 embed() 调用复用 pipeline。
 */
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbedProvider } from '../types.js';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/** 懒加载 pipeline（首次调用才下载模型） */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise;

  // 镜像选择：环境变量优先，否则默认国内镜像
  if (!process.env.HF_ENDPOINT) {
    env.remoteHost = 'https://hf-mirror.com';
  } else {
    env.remoteHost = process.env.HF_ENDPOINT;
  }
  // 允许本地缓存，避免重复下载
  env.allowLocalModels = true;
  env.useBrowserCache = false;

  extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') as Promise<FeatureExtractionPipeline>;
  return extractorPromise;
}

export const XenovaProvider: EmbedProvider = {
  name: 'xenova-minilm',
  dim: 384,

  async embed(text: string): Promise<Float32Array> {
    const extractor = await getExtractor();
    // mean pooling + L2 normalize：all-MiniLM-L6-v2 的标准后处理
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  },
};
