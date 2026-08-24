import { defineConfig } from 'tsdown'

// 宿主自包含打包（同 dsh-polymarket 先例）：除 node: 与原生模块外全部打进
// lib/index.js；better-sqlite3 保持 external（原生 .node 由 pnpm 装入，hippo 同例）。
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  clean: false,
  outputOptions: { entryFileNames: 'index.js' },
  external: ['better-sqlite3'],
  alwaysBundle: (id) => !id.startsWith('node:') && id !== 'better-sqlite3',
})
