/**
 * Provider 注册中心 —— config 里的 name 映射到实际 EmbedProvider 实例。
 *
 * 新增 provider 只需：
 *   1. 在 providers/ 下实现 EmbedProvider 接口
 *   2. 在下面 registry 注册
 *   3. 在 types.ts 的 ProviderConfig.provider 加 name
 */
import { loadConfig } from './config.js';
import type { EmbedProvider } from './types.js';
import { BgeM3Provider, XenovaProvider, OpenAIProvider } from './providers/index.js';

const registry: Record<string, EmbedProvider> = {
  'bge-m3': BgeM3Provider,
  'xenova-minilm': XenovaProvider,
  'openai-small': OpenAIProvider,
};

/** 按当前配置返回 provider（单例缓存由 provider 自己管） */
export function getProvider(): EmbedProvider {
  const cfg = loadConfig();
  return registry[cfg.provider] ?? BgeM3Provider;
}

/** 按 name 显式取 provider（CLI 命令、测试用） */
export function getProviderByName(name: string): EmbedProvider {
  return registry[name] ?? BgeM3Provider;
}

export type { EmbedProvider, ProviderConfig } from './types.js';
export { loadConfig, saveConfig, CONFIG_FILE } from './config.js';
export { BgeM3Provider, XenovaProvider, OpenAIProvider } from './providers/index.js';
