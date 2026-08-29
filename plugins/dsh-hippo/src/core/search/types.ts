/**
 * 语义搜索类型 —— Provider 抽象层。
 *
 * 嵌入模型可能换（本地 Xenova → OpenAI → 国产模型），所以把模型访问
 * 抽象成 EmbedProvider 接口。搜索层只依赖接口，不依赖具体实现。
 *
 * MVP 只实现 XenovaProvider（本地、离线），OpenAIProvider 留空壳接口，
 * 后续切换模型时只需新增 provider 实现 + 改 config。
 */

/** 嵌入提供者：把文本转成定长向量 */
export interface EmbedProvider {
  /** 提供者唯一标识，写入配置用 */
  readonly name: string;

  /** 向量维度（建 vec0 虚拟表时用，all-MiniLM-L6-v2 = 384，openai-small = 1536） */
  readonly dim: number;

  /**
   * 把一段文本转成向量。
   * 实现应自带缓存/懒加载（首次调用才下载模型）。
   */
  embed(text: string): Promise<Float32Array>;
}

/** Provider 配置（持久化到 ~/.agent-memory/config.json） */
export interface ProviderConfig {
  /**
   * 当前使用的 provider name
   * - bge-m3：本地多语言，中文强（默认）
   * - xenova-minilm：本地轻量，英文为主（中文效果差，保留供对比）
   * - openai-small：远程，中英文都强（需 apiKey，空壳实现）
   */
  provider: 'bge-m3' | 'xenova-minilm' | 'openai-small';
  /** OpenAI provider 需要，其他忽略 */
  apiKey?: string;
}

/** 默认配置：bge-m3（中文场景质量优先；纯英文且在意速度可切 xenova-minilm） */
export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: 'bge-m3',
};
