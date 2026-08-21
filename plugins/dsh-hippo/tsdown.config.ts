import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  // 引擎与其原生/大体积依赖一律保持外置：better-sqlite3 / sqlite-vec 是
  // 原生模块（bundle 会破坏 prebuild 装载），transformers 携带模型运行时，
  // hippo-skills 本体按 PLAN 形态策略以 npm 依赖在插件安装时装入。
  external: ['hippo-skills', 'better-sqlite3', 'sqlite-vec', '@zvec/zvec', '@huggingface/transformers'],
})
