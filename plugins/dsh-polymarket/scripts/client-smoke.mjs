/**
 * dsh-polymarket 静态客户端面板冒烟验证（shell.overlay + 浏览器直连 gamma-api）。
 *
 * 对照 agentforge-brain/client.js 的 ModuleLoader 静态形态：
 *  - client.js 通过 window.__ModuleLoader__.load({ id, factory }) 注册
 *  - factory(require) 内 require('react') 取 React；返回 { inject, apply }
 *  - apply(ctx) 注入 shell.overlay，注册 MarketPanel 组件（数据走浏览器 fetch，不经 host.call）
 *
 * 本脚本在 node 中模拟该环境，验证：
 *  1) window.__ModuleLoader__.load 被调用，factory 返回 { inject:['slots'], apply }
 *  2) apply 经 ctx.slots.inject('shell.overlay') 注册 id=dsh-polymarket
 *  3) injectStyle 注入 style#dsh-polymarket-style
 *  4) MarketPanel 挂载后 fetch gamma-api/public-search?q=president&limit=5
 *  5) 重渲染后渲染树含事件标题与 Yes 报价
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(__dirname, '..', 'client.js'), 'utf8')

// —— 预置行情（与 Gamma /public-search 返回结构一致：{events:[{title,markets:[{question,outcomesPrices,volume}]}]}）——
const fakeMarket = {
  events: [
    {
      title: 'Who will win the 2028 US presidential election?',
      markets: [
        {
          question: 'Who will win the 2028 US presidential election?',
          outcomesPrices: '["0.48","0.52"]',
          volume: 12345,
        },
      ],
    },
  ],
}

let fetchCalls = []
const fetchMock = async (url, opts) => {
  fetchCalls.push({ url, opts })
  return { ok: true, status: 200, json: async () => fakeMarket }
}

// —— React mock：手工驱动渲染循环 ——
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
    useEffect: (fn) => {
      effectQueue.push(fn)
    },
  }
  return {
    React,
    render: (Component, props) => {
      hookIndex = 0
      effectQueue.length = 0
      return Component(props || {})
    },
    pendingEffects: () => effectQueue,
  }
}

const react = makeReact()

// —— document mock（供 injectStyle）——
const styleStore = {}
const documentMock = {
  getElementById: (id) => styleStore[id] || null,
  createElement: (tag) => ({ tag, id: '', textContent: '' }),
  head: { appendChild: (el) => { styleStore[el.id] = el } },
}

// —— window mock（供 __ModuleLoader__.load）——
let captured = null
const windowMock = { __ModuleLoader__: { load: (spec) => { captured = spec } } }

const requireMock = (name) => {
  if (name === 'react') return react.React
  throw new Error('unexpected require: ' + name)
}

// —— 求值 client.js（静态形态：window.__ModuleLoader__.load 在顶层触发）——
const runner = new Function('window', 'document', 'fetch', code)
runner(windowMock, documentMock, fetchMock)

if (!captured) throw new Error('window.__ModuleLoader__.load 未被调用')
const plugin = captured.factory(requireMock)
if (!plugin || typeof plugin.apply !== 'function') throw new Error('plugin.apply 不存在')
if (!Array.isArray(plugin.inject) || plugin.inject[0] !== 'slots') {
  throw new Error('plugin.inject 应为 ["slots"]，实际 ' + JSON.stringify(plugin.inject))
}
console.log('[OK] window.__ModuleLoader__.load 注册 -> plugin.inject =', JSON.stringify(plugin.inject))

// —— 构建 ctx 并 apply ——
const entries = []
const ctx = {
  slots: {
    inject: (key, registerFn) => entries.push({ viaInject: true, key, registerFn }),
    register: (options, Component) => entries.push({ viaInject: false, options, Component }),
  },
}
plugin.apply(ctx)

const injectEntry = entries.find((e) => e.viaInject && e.key === 'shell.overlay')
if (!injectEntry) throw new Error('应通过 ctx.slots.inject 注册 shell.overlay')
console.log('[OK] ctx.slots.inject(key=shell.overlay) 已注册')

injectEntry.registerFn() // 触发 register
const reg = entries.find(
  (e) => !e.viaInject && e.options && e.options.name === 'shell.overlay' && e.options.id === 'dsh-polymarket',
)
if (!reg) throw new Error('应 register 到 shell.overlay id=dsh-polymarket')
if (typeof reg.Component !== 'function') throw new Error('注册的 Component 应为函数')
console.log('[OK] ctx.slots.register({name:shell.overlay, id:dsh-polymarket}) 已注册')

// —— 样式注入校验 ——
if (!styleStore['dsh-polymarket-style']) throw new Error('injectStyle 应注入 style#dsh-polymarket-style')
console.log('[OK] injectStyle 注入 style#dsh-polymarket-style')

// —— 首次渲染（loading 态）→ 驱动 effect（fetch）→ 等待微任务 → 重渲染（ready 态）——
const Comp = reg.Component
react.render(Comp, {})
for (const fn of react.pendingEffects()) fn()
await new Promise((r) => setTimeout(r, 10)) // 冲刷 promise 链
const readyTree = react.render(Comp, {})
const readyJson = JSON.stringify(readyTree)

if (fetchCalls.length === 0) throw new Error('fetch 未被调用')
const f = fetchCalls[0]
if (!f.url.includes('gamma-api.polymarket.com/public-search')) {
  throw new Error('fetch URL 应为 gamma-api/public-search，实际 ' + f.url)
}
if (!f.url.includes('q=president')) throw new Error('fetch 缺 q=president')
if (!f.url.includes('limit=5')) throw new Error('fetch 缺 limit=5')
console.log('[OK] fetch ->', f.url)

if (!readyJson.includes('presidential election')) throw new Error('渲染树缺少事件标题')
if (!readyJson.includes('Yes ≈ 0.48')) throw new Error('渲染树缺少 Yes 报价')
console.log('[OK] 渲染树含事件标题与 Yes 报价')

console.log('\n=== 静态客户端面板冒烟全部通过 ===')
