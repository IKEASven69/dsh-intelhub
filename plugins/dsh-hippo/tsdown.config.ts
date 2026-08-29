import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const ROOT = dirname(fileURLToPath(import.meta.url))

// host 半自包含打包：借道 dsh-polymarket 验证过的管线（issue #1）——
// 目录外 link: 装配不装 peers，Node 从包真实路径解析不到 @deepseek-ai/*
// 会整棵 plugin tree 加载失败。打包后 lib 里仅剩 node: 内置与原生模块外置引用。
// 入口是 tsconfig.build.json 的 tsc 产物（.tsc/）：tsdown/rolldown 不转换
// stage-3 装饰器（@Remote），先过 tsc（与 harness 的 tsc -b && tsdown 同构）。
// 原生模块必须外置：better-sqlite3 / sqlite-vec 是原生模块（bundle 破坏
// prebuild 装载），@zvec/zvec 同为原生存储，transformers 携带模型运行时。
// 引擎源码（原 hippo-mind 包）已并入本包 src/，随插件一起内联进 lib——
// 独立引擎包依赖随包合并移除。
const ENGINE_EXTERNALS = ['better-sqlite3', '@zvec/zvec', '@huggingface/transformers']

const isEngineExternal = (id: string) =>
  ENGINE_EXTERNALS.some((e) => id === e || id.startsWith(e + '/'))

const hostBundle: UserConfig = {
  entry: { index: join(ROOT, '.tsc', 'index.js') },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  external: ENGINE_EXTERNALS,
  deps: {
    alwaysBundle: (id: string) => !id.startsWith('node:') && !isEngineExternal(id),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

export default [hostBundle] satisfies UserConfig[]
