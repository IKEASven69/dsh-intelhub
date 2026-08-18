import type { UserConfig } from 'tsdown'

// 宿主自包含打包：把 @deepseek-ai/dsh-tools / cordis / schemastery 等运行时
// 依赖打进 lib/index.js（node: 内置模块保持 external）。官方装配
// （dsh plugin add <目录>）对目录外 link: 依赖不装 peers，Node 从包真实路径
// 解析不到 '@deepseek-ai/dsh-tools' 会整棵 plugin tree 加载失败（issue #1）
// ——打包后 lib 零外部依赖，任何装配路径都能加载。
// （纯只读工具包，无 client UI，故只有 hostBundle。）
const hostBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    alwaysBundle: (id: string) => !id.startsWith('node:'),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

export default [hostBundle] satisfies UserConfig[]
