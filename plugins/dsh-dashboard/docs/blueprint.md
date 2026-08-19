# dash-1 活动仪表盘 —— 长期化蓝本

> 这是动态插件 `dash-1/pkg-28` 的完整源码快照,用于「落成仓库正式插件」(方案 1)时的 TypeScript 改写蓝本。
> 动态插件是进程本地的,重启会丢;此文件是持久蓝本。

## 落点规划(仓库)

- Client 半区 → 新包 `packages/client/ui-dashboard`(`@deepseek-ai/dsh-client-ui-dashboard`),浏览器 UI 用 `React.createElement` 需改写为 JSX + CSS Modules,props 走 four-shares。
- Host 半区 → 新 host 包(`packages/.../dashboard` 或并入 web bundle),事件监听 / web 路由 / RPC / `compact_now` 工具 / 高危拦截。
- 注册:`packages/client/tsconfig.client.json` 的 references;`packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` 行;`packages/bundle/web-app/package.json` 依赖;host 侧 composition 行。
- 门禁:`pnpm typecheck / lint / test:gui / snapshot / doc-sync` + Agent Note。

## 依赖的服务(host)

`agents` `sessions` `sessionProjections` `tokenMeter` `skills` `goals` `sessionTitle` `jobs` `shell` `webServer` `sandboxPolicy` `agentDefaultModel` `compaction`(经工具 exec.signal)。
受限环境无 `AbortController`/`AbortSignal`/`process`/`Buffer`/`fetch`,故主动压缩走注册工具的 `exec.signal`、CLI 启动走 `shell.start`、飞书推送走 `shell.run('curl ...')`。

## 关键坑(改写时保留)

1. web 路由必须 `ctx.effect(() => webServer.register(...))` 持有 disposer,否则 update 泄漏。
2. 高危拦截 `dangerous()` 只扫 `pwsh/bash/shell/subprocess/terminal` 的 `command/args/cmd/argv`,不能用 `JSON.stringify(args)` 兜底(会误伤含 `rm -rf` 字样的任意工具)。
3. `harness.defineTool` 的 `output.schema` 需 `additionalProperties:false` + 每属性 `required:true`(不支持顶层 `required` 数组);`parameters` 无参时 `additionalProperties` 省略。

---

## HOST 半区源码

```js
return {
  apply(ctx) {
    const state = { since: Date.now(), toolByName: Object.create(null), pendingApprovals: 0, log: [] }
    const tokens = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const agentStatus = Object.create(null)
    const activeRuns = Object.create(null)
    const cliProcs = Object.create(null)
    let cliSeq = 0
    let lastUsage = null
    let recentText = ''
    let samples = []
    let scanCache = { key: '', skill: Object.create(null), compactions: [] }
    const PRICES = {
      'deepseek-v4-flash': { offpeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }, peak: { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 } },
      'deepseek-v4-pro': { offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 } },
    }
    const EFFECTIVE_AT = '2026-08-17'
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    const push = (kind, label) => { state.log.push({ t: Date.now(), kind, label }); if (state.log.length > 60) state.log.splice(0, state.log.length - 60) }
    const commandLabel = (name, args) => { if (args && typeof args === 'object') { for (const k of ['command', 'file_path', 'pattern', 'path', 'query', 'description', 'objective', 'name']) { const v = args[k]; if (typeof v === 'string' && v) return name + ' ' + v.slice(0, 60) } } return name }
    const dangerous = (exec) => {
      const name = exec && typeof exec.name === 'string' ? exec.name.toLowerCase() : ''
      if (name !== 'pwsh' && name !== 'bash' && name !== 'shell' && name !== 'subprocess' && name !== 'terminal') return null
      const a = exec && exec.arguments
      let cmd = ''
      if (a && typeof a === 'object') { if (typeof a.command === 'string') cmd = a.command; else if (typeof a.args === 'string') cmd = a.args; else if (typeof a.cmd === 'string') cmd = a.cmd; else if (Array.isArray(a.argv)) { try { cmd = a.argv.join(' ') } catch (e) {} } }
      if (!cmd) return null
      const PATTERNS = [
        { re: /rm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive\s+--force|--force\s+--recursive)/i, label: 'rm -rf' },
        { re: /(?:^|[\s;&|])rm\s+(?:-[a-z]*r[a-z]*\s+)?\/\s*([\s;&|]|$)/i, label: 'rm 根目录' },
        { re: /mkfs(\.\w+)?\s/i, label: 'mkfs 格式化' },
        { re: /dd\s+.*of=\/dev\//i, label: 'dd 写磁盘设备' },
        { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, label: 'fork bomb' },
        { re: />\s*\/dev\/(sd|hd|nvme|mmcblk|vd)[a-z]*/i, label: '覆盖磁盘设备' },
      ]
      for (const p of PATTERNS) { if (p.re.test(cmd)) return p.label }
      return null
    }
    const beijingPeak = (now) => { const hour = new Date(now + 8 * 3600 * 1000).getUTCHours(); return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) }
    const rateFor = (model, now) => { const t = PRICES[model] || PRICES['deepseek-v4-pro']; const p = beijingPeak(now) ? t.peak : t.offpeak; return { model: model || 'deepseek-v4-pro', band: beijingPeak(now) ? 'peak' : 'offpeak', cacheHit: p.cacheHit, cacheMiss: p.cacheMiss, output: p.output } }
    const usageCost = (usage, model, now) => { const r = rateFor(model, now); return (num(usage ? usage.uncachedInputTokens : 0) * r.cacheMiss + num(usage ? usage.cacheReadTokens : 0) * r.cacheHit + num(usage ? usage.cacheWriteTokens : 0) * r.cacheMiss + num(usage ? usage.outputTokens : 0) * r.output) / 1e6 }
    const foldUsage = (turn, step, usage) => { /* 按 turn/step 去重折叠 input/output/cache */ }
    const extractText = (message) => { /* 从 content blocks 取文本 */ }
    const features = (text) => { /* ascii 词 + CJK bigram 集合 */ }
    const predictSkills = (catalog, text, limit) => { /* 词频-重叠打分 softmax */ }
    const scanSession = (session) => { /* 扫 session.events: skill 加载计数 + compaction/summary 列表,带长度缓存 */ }
    // 事件监听: tools/pre-execute(高危拦截), agent/status, tools/result, session/event, workflow/start, subagent/start|end, agent/error, approval/request
    // 工具注册: harness.registerTool(ctx, harness.defineTool({ name:'compact_now', parameters:{type:'object',properties:{}}, output:{schema:{type:'object',additionalProperties:false,properties:{compacted:{type:'boolean',required:true},shadowedTokens:{type:'number',required:true},note:{type:'string',required:true}}},render}, async execute(args,exec){ compaction.compactNow(agent, exec.signal) } }))
    // RPC: activity/snapshot(buildSnapshot), compact-now(followup 唤醒), launch-cli(shell.start 后台), kill-cli
    // web 路由(全部 ctx.effect 持有): /dsh-dash/export(JSON), /dsh-dash/export.ndjson, /dsh-dash/stream(SSE)
    // buildSnapshot 返回: since/now/toolByName/pendingApprovals/log/tokens/rate/skills/context/samples/compactions/goal/agents/jobs/activeRuns/cliProcs/export
  },
}
```

> 注:上面 `foldUsage` 等辅助函数与事件监听的具体实现已在 pkg-28 源里完整写出,此处按逻辑标注;长期化时用 `cordis_inspect_self('dash-1','pkg-28')` 的 `code.host` 字段取原文即可(本文件正文之上的 HOST 块即为压缩前导版)。

## CLIENT 半区源码(浏览器 UI)

- 注入 `sidebar.footer.action`(id `activity-dash-toggle`)与 `shell.overlay`(id `activity-dash-panel`)。
- 状态:`ui = { open, mode:'compact' }` + `useUi`/`useSnapshot(sessionId)`(3s 轮询 `host.call('activity/snapshot')`)。
- 组件:`Dot` `TokenRow` `Sparkline` `CompBar` `CompactionItem`(可展开) `CliLauncher`(4 CLI 按钮 + 进程列表 + 停止) `Dashboard`。
- Dashboard 区块顺序:费用(峰谷)→ CLI 接力 → (完整版)上下文压力 → 压缩摘要(+主动压缩按钮) → 编排成本 → 编排拓扑 → Skill 雷达 → (完整版)Token 消耗/常用工具 → 活动日志(折叠) → (完整版)外部桥接。
- 全部样式走 `styles.insert` + `--dsw-alias-*` 主题 token;无字面颜色(除 skill/predict/compaction 徽标)。
- 完整样式与组件代码 = `cordis_inspect_self('dash-1','pkg-28').code.client`。

## 附加:IM 桥插件 `imbr-2`(另一蓝本)

网页直连(`/dsh-im/` 聊天页 + 二维码 + 工作区/会话列表切换 + `/dsh-im/send|stream|switch|info|feishu`),飞书推送走 `shell.run('curl -X POST ...')`。长期化时同样落为仓库插件(飞书双向需 `node:crypto` + WebSocket + 凭证,只能在正式插件里做)。
