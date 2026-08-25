// 本机验证构建:SWC(stage-3 装饰器转译)+ esbuild 打包。
// 背景:tsdown/rolldown 与 esbuild 均只"透传"stage-3 装饰器,而 dsh 运行时
// 不做转译(实测 depsec 加载报 Invalid token);SWC decoratorVersion 2022-03
// 可产出与官方发布包一致的 addInitializer 形态。正式构建仍走 tsdown(需修
// 上游 dsh-type-meta 发布问题或用 harness 工具链)。
// 首次使用:在本目录执行 `npm init -y && npm install @swc/core esbuild`,然后 `node build.cjs`。
const fs = require('node:fs')
const path = require('node:path')
const swc = require('@swc/core')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const srcDir = path.join(root, 'src')
const tmpDir = path.join(__dirname, 'tmp-src')
const outDir = path.join(root, 'lib')

fs.mkdirSync(tmpDir, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
for (const f of files) {
  const r = swc.transformFileSync(path.join(srcDir, f), {
    jsc: {
      parser: { syntax: 'typescript', decorators: true },
      transform: { decoratorVersion: '2022-03' },
      target: 'es2022',
    },
    module: { type: 'es6' },
    isModule: true,
  })
  const code = r.code.replace(/(\.{1,2}\/[\w./@-]+)\.ts(['"])/g, '$1.js$2')
  fs.writeFileSync(path.join(tmpDir, f.replace(/\.ts$/, '.js')), code)
}

// 宿主半的 @deepseek-ai/* 保持外部化（运行时/构建环境供给）：
// 构建期由 scripts/link-deps.mjs 从 checkout junction 到本目录 node_modules
// （esbuild 不解析 external，junction 供 node/tsc 解析）；运行期 link: 安装下
// ESM 以真实路径向上解析，同样落到本目录 node_modules 的 junction——
// 2026-08-23 实测：无 junction 时 web 启动报 Cannot find package '@deepseek-ai/cordis'。
esbuild
  .buildSync({
    entryPoints: [path.join(tmpDir, 'index.js')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['@deepseek-ai/*', 'react', 'react/*'],
    outfile: path.join(outDir, 'index.js'),
  })
console.log(`lib/index.js  ${(fs.statSync(path.join(outDir, 'index.js')).size / 1024).toFixed(1)} kB`)

// client 半必须是 __ModuleLoader__ 注册格式(与官方 client bundle 一致):
// window.__ModuleLoader__.load({ id: <包名>, factory: (require) => CJS 模块 })
// 先用 esbuild 产出 CJS 体,再包注册层。
esbuild.buildSync({
  entryPoints: [path.join(tmpDir, 'client.js')],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2022',
  external: ['@deepseek-ai/*', 'react', 'react/*'],
  outfile: path.join(__dirname, 'tmp-client.cjs'),
})
const cjsBody = fs.readFileSync(path.join(__dirname, 'tmp-client.cjs'), 'utf8')

// client.css → inline <style> 注入。M0 用纯字符串替换：build 时直接读 CSS
// 文件内容，escape 反引号/反斜杠/$，拼到 factory 顶部。runtime 第一次执行
// 时把 <style> append 到 document.head，浏览器自然应用。
const cssPath = path.join(root, 'src', 'client.css')
const cssText = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : ''
const cssInjected = cssText.length === 0 ? '' :
  `\t\tif (typeof document !== 'undefined' && !document.getElementById('dsh-trust-list-css')) {\n` +
  `\t\t\tvar s = document.createElement('style');\n` +
  `\t\t\ts.id = 'dsh-trust-list-css';\n` +
  `\t\t\ts.textContent = ${JSON.stringify(cssText)};\n` +
  `\t\t\tdocument.head.appendChild(s);\n` +
  `\t\t}\n`

const clientWrapped = `window.__ModuleLoader__.load({
\tid: "dsh-trust-list",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${cssInjected}${cjsBody
  .split('\n')
  .map((l) => (l.length === 0 ? '' : '\t\t' + l))
  .join('\n')}
\t\treturn module.exports;
\t}
});
`
fs.writeFileSync(path.join(outDir, 'client.js'), clientWrapped)
console.log(`lib/client.js  ${(fs.statSync(path.join(outDir, 'client.js')).size / 1024).toFixed(1)} kB`)
console.log('local build done (swc stage-3 decorators + esbuild + module-loader wrapper)')
