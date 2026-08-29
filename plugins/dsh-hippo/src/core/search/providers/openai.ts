/**
 * OpenAI 嵌入 provider —— 中英质量更强的可选实现。
 *
 * 模型：text-embedding-3-small（1536 维，中英文都强）
 * 需要 OPENAI_API_KEY（或配置文件里 apiKey）。
 *
 * 当前为空壳实现：接口已就位，调用时抛 NotImplemented。等真正需要时：
 *   1. npm install openai
 *   2. 把下面的 embed() 改为真实 API 调用
 *   3. config.json 设 provider: 'openai-small' + apiKey
 *
 * 之所以现在留着空壳：provider 抽象要完整，后续切换模型时不动搜索层。
 */
import type { EmbedProvider } from '../types.js';

export const OpenAIProvider: EmbedProvider = {
  name: 'openai-small',
  dim: 1536,

  async embed(_text: string): Promise<Float32Array> {
    throw new Error(
      'OpenAI provider 尚未实现（空壳）。当前默认使用本地 Xenova。' +
      '要启用 OpenAI：npm install openai，然后在 providers/openai.ts 补全 embed()。'
    );
  },
};
