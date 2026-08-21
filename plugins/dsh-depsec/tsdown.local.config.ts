// 本机验证用构建配置:跳过 dts 生成,避免依赖未公开发布的 @deepseek-ai 类型包。
// 正式构建仍用 tsdown.config.ts(dts: true),需在具备完整工具链的环境执行。
export default {
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
  },
  format: ['esm'],
  dts: false,
  clean: true,
  platform: 'neutral',
  outDir: 'lib',
  tsconfig: './tsconfig.local.json',
}
