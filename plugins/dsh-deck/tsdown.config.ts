import { defineConfig } from 'tsdown'

// 宿主自包含打包（同 dsh-polymarket 先例）：除 node: 外全部打进 lib/index.js，
// link: 安装在任何路径都能加载。
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  clean: false,
  outputOptions: { entryFileNames: 'index.js' },
  alwaysBundle: (id) => !id.startsWith('node:'),
})
