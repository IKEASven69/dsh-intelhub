import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const ROOT = dirname(fileURLToPath(import.meta.url))

// host 半自包含打包（借 dsh-hippo 验证过的管线）：zvec 单写锁由引擎短持
// （withEngine）管理，hippo-skills 及其原生依赖一律外置。
const ENGINE_EXTERNALS = ['hippo-skills', 'better-sqlite3', 'sqlite-vec', '@zvec/zvec', '@huggingface/transformers']

export default [{
  entry: { index: join(ROOT, '.tsc', 'index.js') },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  external: ENGINE_EXTERNALS,
  deps: {
    alwaysBundle: (id: string) => !id.startsWith('node:') && !ENGINE_EXTERNALS.some((e) => id === e || id.startsWith(e + '/')),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}] satisfies UserConfig[]
