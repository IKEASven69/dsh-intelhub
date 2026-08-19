/**
 * dsh-polymarket 浏览器半包冒烟验证。
 * 模拟 cordis-client-runner 求值环境（对照 evaluator.ts）：
 *  - evaluateClient: 代码包进 `new Function(...parameters, `return (async () => {\n${code}\n})()`)`
 *    parameters = ['React','console','styles','host','harness', ...Object.keys(traps), 'process','Buffer']
 *  - React mock：createElement 返回描述树；useState/useEffect 手工驱动渲染循环
 *  - host mock：记录 call(method,args)，返回预置搜索结果；styles mock 收集 CSS
 *  - document mock：两种登录态（有会话 cookie / 无 cookie）
 * 验证：求值出对象插件 {name,inject,apply}；slots.inject 注册 tool.view.cordis key=self；
 *      组件渲染含 host.call 拉取的数据与登录态徽标；无 cookie 时渲染提示。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../src/client-half.js', import.meta.url), 'utf8')
const trapNames = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'require']

// —— 预置搜索结果（与 host 半 search_markets 返回结构一致：{count, events[]}）——
const fakeSearch = {
  count: 2,
  events: [
    {
      title: 'Who will win the 2028 US presidential election?',
      slug: 'us-presidential-election-winner-2028',
      markets: [
        {
          question: 'Who will win the 2028 US presidential election?',
          outcomesPrices: '{"Yes":"0.48","No":"0.52"}',
        },
      ],
    },
    {
      title: 'Will the Fed cut rates in March 2027?',
      slug: 'fed-cuts-march-2027',
      markets: [{ question: 'Will the Fed cut rates?', outcomesPrices: '{"Yes":"0.35"}' }],
    },
  ],
}

// —— mock 构建器 ——
function makeHost() {
  const calls = []
  return {
    calls,
    call: (method, args) => {
      calls.push({ method, args })
      if (method === 'polymarket_search_markets') return Promise.resolve(fakeSearch)
      return Promise.reject(new Error('unexpected method: ' + method))
    },
  }
}

function makeStyles() {
  const cssList = []
  return {
    cssList,
    insert: (css) => { cssList.push(css) },
  }
}

/** React mock：手工驱动渲染。render(Component, props) 返回组件当前状态树；
 *  组件内 useEffect 会被收集（pendingEffects），随后宿主驱动它们（host.call 的 .then 触发 setState），
 *  再次 render 即得到 ready 态树。 */
function makeReact() {
  let hookIndex = 0
  const stateByIndex = new Map()
  const effectQueue = []

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    }),
    useState: (initial) => {
      const idx = hookIndex++
      if (!stateByIndex.has(idx)) {
        stateByIndex.set(idx, typeof initial === 'function' ? initial() : initial)
      }
      const set = (value) => {
        stateByIndex.set(idx, typeof value === 'function' ? value(stateByIndex.get(idx)) : value)
      }
      return [stateByIndex.get(idx), set]
    },
    useEffect: (fn) => { effectQueue.push(fn) },
  }

  return {
    React,
    render: (Component, props) => {
      hookIndex = 0
      effectQueue.length = 0
      const tree = Component(props || {})
      return tree
    },
    pendingEffects: () => effectQueue,
  }
}

// —— 模拟 evaluateClient：new Function 参数面 ——
function evaluateClient(symbols) {
  const { React, taggedConsole, styles, host, harness } = symbols
  const traps = {}
  for (const name of trapNames) {
    traps[name] = () => { throw new Error(`${name} is shadowed in browser half`) }
  }
  const parameters = ['React', 'console', 'styles', 'host', 'harness', ...trapNames, 'process', 'Buffer']
  const factory = new Function(...parameters, `return (async () => {\n${code}\n})()`)
  return factory(
    React, taggedConsole, styles, host, harness,
    ...trapNames.map((n) => traps[n]),
    undefined, undefined, // process / Buffer
  )
}

const tagLog = (tag) => (...a) => console.log(`[${tag}]`, ...a)

// —— 场景 A：已登录（有会话 cookie）——
console.log('\n=== 场景 A：document.cookie 有会话标识 ===')
{
  globalThis.document = { cookie: 'dsh_session=abc123; Path=/; Secure' }
  const host = makeHost()
  const styles = makeStyles()
  const react = makeReact()
  const entries = []
  const ctx = {
    slots: {
      inject: (key, fn) => entries.push({ viaInject: true, key, fn }),
      register: (options, Component) => entries.push({ viaInject: false, options, Component }),
    },
  }

  let plugin
  try {
    plugin = await evaluateClient({
      React: react.React,
      taggedConsole: tagLog('client'),
      styles,
      host,
      harness: { call: () => Promise.reject(new Error('harness should not be used')) },
    })
  } catch (e) {
    console.error('[FAIL] 浏览器半求值失败:', e.message)
    process.exit(1)
  }
  console.log('[OK] 求值成功 ->', JSON.stringify({ name: plugin?.name, inject: plugin?.inject }))

  if (plugin?.name !== 'dsh-polymarket') throw new Error('plugin.name 应为 dsh-polymarket')
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) throw new Error('inject 应为 [slots]')
  if (typeof plugin.apply !== 'function') throw new Error('plugin.apply 应为函数')

  plugin.apply(ctx)
  const injectEntry = entries.find((e) => e.viaInject && e.key === 'tool.view.cordis')
  if (!injectEntry) throw new Error('应通过 slots.inject 注册 tool.view.cordis')
  console.log('[OK] slots.inject(key=tool.view.cordis) 已注册')

  injectEntry.fn() // 触发 register
  const reg = entries.find((e) => !e.viaInject && e.options?.name === 'tool.view.cordis' && e.options?.key === 'self')
  if (!reg) throw new Error('应 register 到 tool.view.cordis key=self')
  if (typeof reg.Component !== 'function') throw new Error('注册的 Component 应为函数')
  console.log('[OK] slots.register({name:tool.view.cordis, key:self}) 已注册')

  // 首次渲染（loading 态）→ 驱动 effects（host.call）→ 等待微任务 → 重渲染（ready 态）
  const Comp = reg.Component
  const first = react.render(Comp, { packageId: 'pkg-demo' })
  for (const fn of react.pendingEffects()) fn()
  await Promise.resolve()
  await Promise.resolve()
  const readyTree = react.render(Comp, { packageId: 'pkg-demo' })
  const readyJson = JSON.stringify(readyTree)

  console.log('[OK] host.call 调用次数:', host.calls.length, '->', host.calls.map((c) => c.method).join(', '))
  if (host.calls.length === 0) throw new Error('host.call 未被调用')
  const call = host.calls[0]
  if (call.method !== 'polymarket_search_markets') throw new Error('首个调用应为 polymarket_search_markets')
  if (call.args?.q !== 'president' || call.args?.limit !== 5) throw new Error(`args 不符: ${JSON.stringify(call.args)}`)
  console.log('[OK] host.call args ->', JSON.stringify(call.args))

  const checks = [
    ['已检测徽标', 'DSH 会话已检测'],
    ['事件1标题', 'presidential election'],
    ['事件2标题', 'Fed cut rates'],
    ['Yes 报价', 'Yes 48%'],
    ['市场数', '1 市场'],
    ['package 信息脚注', 'pkg-demo'],
  ]
  for (const [label, needle] of checks) {
    if (!readyJson.includes(needle)) throw new Error(`渲染树缺少「${label}」: ${needle}`)
    console.log(`[OK] 渲染树包含「${label}」`)
  }

  if (styles.cssList.length !== 1) throw new Error('styles.insert 应被调用 1 次')
  const css = styles.cssList[0]
  for (const token of ['--dsw-alias-bg-layer-1', '--dsw-alias-label-primary', 'dpm-card']) {
    if (!css.includes(token)) throw new Error(`CSS 缺少 token: ${token}`)
  }
  console.log('[OK] styles.insert 注入主题 CSS（theme 变量齐全）')
  console.log('[OK] 场景 A 全部通过')
}

// —— 场景 B：未登录（document.cookie 为空）——
console.log('\n=== 场景 B：document.cookie 为空 ===')
{
  globalThis.document = { cookie: '' }
  const host = makeHost()
  const styles = makeStyles()
  const react = makeReact()
  const entries = []
  const ctx = {
    slots: {
      inject: (key, fn) => entries.push({ viaInject: true, key, fn }),
      register: (options, Component) => entries.push({ viaInject: false, options, Component }),
    },
  }

  const plugin = await evaluateClient({
    React: react.React,
    taggedConsole: tagLog('client'),
    styles,
    host,
    harness: { call: () => Promise.reject(new Error('harness should not be used')) },
  })
  plugin.apply(ctx)
  const injectEntry = entries.find((e) => e.viaInject && e.key === 'tool.view.cordis')
  injectEntry.fn()
  const reg = entries.find((e) => !e.viaInject && e.options?.name === 'tool.view.cordis')

  const Comp = reg.Component
  const first = react.render(Comp, { packageId: 'pkg-demo' })
  for (const fn of react.pendingEffects()) fn()
  await Promise.resolve()
  await Promise.resolve()
  const tree = react.render(Comp, { packageId: 'pkg-demo' })
  const json = JSON.stringify(tree)

  if (!json.includes('未检测到 DSH 会话 cookie')) throw new Error('未登录态应渲染提示徽标')
  console.log('[OK] 渲染树包含未登录提示徽标')
  // 行情数据仍应拉取（登录检查不影响数据通路）
  if (host.calls.length === 0) throw new Error('未登录时行情数据也应走 host.call')
  console.log('[OK] 未登录时仍通过 host.call 拉取行情（数据通路不受登录态影响）')
  if (!json.includes('presidential election')) throw new Error('未登录态仍应渲染行情事件')
  console.log('[OK] 未登录态仍渲染行情事件')
  console.log('[OK] 场景 B 全部通过')
}

console.log('\n=== 浏览器半冒烟全部通过 ===')
