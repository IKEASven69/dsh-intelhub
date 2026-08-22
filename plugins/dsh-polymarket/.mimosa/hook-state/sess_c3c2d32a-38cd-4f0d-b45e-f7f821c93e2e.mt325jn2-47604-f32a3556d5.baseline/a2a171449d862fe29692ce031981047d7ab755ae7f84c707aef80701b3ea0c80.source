/**
 * @dsh-external/dsh-polymarket — Polymarket 预测市场只读行情工具包。
 *
 * DSH 生态首个 Polymarket 原生插件。5 个只读工具：
 *  search_markets / get_market / get_orderbook / get_price / get_price_history。
 *
 * token 双体系（实测结论）：
 *  - Gamma 给 `conditionId`（0x 十六进制），搜索结果/市场元数据的天然主键；
 *  - CLOB 需要 `token_id`（十进制字符串），book/price/midpoint/prices-history
 *    全部消费十进制 token；
 *  - 链路：conditionId → CLOB /markets/{conditionId} → tokens[].token_id →
 *    book/price/history。
 * 本插件对外统一暴露 `condition_id`（与 Gamma/CLOB 的字段命名一致），内部
 * 自动完成 conditionId → token_id 转换，agent 无需感知。
 *
 * 高性能铁律（参考 dsh-super-injector dev_scaffold_plugin，DeepSeek V4 Pro 实测）：
 *  1. 工具 schema 精简：description 短句点明用途，返回数据即说明书；
 *  2. 首轮锚定：5 个工具面偏大，首轮只露 search_markets 一个入口，
 *     首个调用落地后恢复全部——启用步骤见 apply() 末尾注释块。
 *
 * 构建：tsdown 宿主自包含打包（除 node: 外全部打进 lib/index.js），
 * 官方装配 `dsh plugin --profile web add <目录>` 任何路径都能加载。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'

export const name = 'dsh-polymarket'
export const inject = ['tools']

export interface Config {
  /** Gamma API 基础地址（只读市场元数据/搜索）。 */
  gammaBase: string
  /** CLOB API 基础地址（订单簿/价格/历史）。 */
  clobBase: string
  /** 单次 HTTP 请求超时（ms）。 */
  timeoutMs: number
}

export const Config = z.object({
  gammaBase: z.string().default('https://gamma-api.polymarket.com'),
  clobBase: z.string().default('https://clob.polymarket.com'),
  timeoutMs: z.number().min(1000).max(60000).default(10000),
})

// ─────────────────────────────────────────────────────────────────────
// 内部工具：HTTP 与 token 转换
// ─────────────────────────────────────────────────────────────────────

/** 带 UA 与超时的 JSON GET；非 2xx 抛错（含状态码与响应体摘要）。 */
async function fetchJson(base: string, path: string, timeoutMs: number): Promise<unknown> {
  const url = base + path
  const res = await fetch(url, {
    headers: { 'user-agent': 'dsh-polymarket/0.1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    throw new Error(`Polymarket API ${res.status} ${url}: ${body}`)
  }
  return res.json() as Promise<unknown>
}

/** CLOB /markets/{conditionId} 的 tokens 形态（只取需要字段）。 */
interface ClobToken {
  token_id: string
  outcome: string
}

/** 按 outcome（Yes/No）解析某个 conditionId 的十进制 token_id。 */
async function tokenIdFor(
  clobBase: string,
  timeoutMs: number,
  conditionId: string,
  side: 'yes' | 'no',
): Promise<string> {
  const data = (await fetchJson(clobBase, `/markets/${conditionId}`, timeoutMs)) as {
    tokens?: ClobToken[]
  }
  const tokens = data.tokens ?? []
  const want = side === 'yes' ? 'yes' : 'no'
  const token = tokens.find((t) => t.outcome.toLowerCase() === want)
  if (!token) {
    throw new Error(`Polymarket: conditionId ${conditionId} 无 ${side} 侧 token（tokens=${tokens.map((t) => t.outcome).join(',') || '空'}）`)
  }
  return token.token_id
}

// ─────────────────────────────────────────────────────────────────────
// 工具 args 类型与输出渲染
// ─────────────────────────────────────────────────────────────────────

interface SearchArgs {
  q: string
  limit?: number
}

interface MarketArgs {
  condition_id: string
}

interface BookArgs {
  condition_id: string
  side?: 'yes' | 'no'
}

interface PriceArgs {
  condition_id: string
  side?: 'yes' | 'no'
}

interface HistoryArgs {
  condition_id: string
  interval?: string
  fidelity?: number
}

/** 统一渲染：JSON 字符串直接作为 text 输出（schema 精简原则——返回即文档）。 */
function renderText(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: String(value) }]
}

// ─────────────────────────────────────────────────────────────────────
// 插件主体
// ─────────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const { gammaBase, clobBase, timeoutMs } = config

  // 1) 搜索市场（Gamma /public-search，返回事件+市场精简字段）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'polymarket_search_markets',
    description: '搜索 Polymarket 预测市场（关键词 → 事件/市场列表，含 condition_id 供后续工具使用）',
    parameters: {
      q: { type: 'string', required: true, description: '关键词，如 "2028 president" 或 "BTC"' },
      limit: { type: 'integer', description: '返回市场条数上限（默认 5）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: SearchArgs) {
      const limit = args.limit ?? 5
      const data = (await fetchJson(gammaBase, `/public-search?q=${encodeURIComponent(args.q)}&limit=${limit}`, timeoutMs)) as {
        events?: Array<{
          title?: string
          id?: string
          markets?: Array<{
            conditionId?: string
            question?: string
            outcomePrices?: string
            volume?: number
          }>
        }>
      }
      const events = data.events ?? []
      const summary = events.map((e) => ({
        title: e.title ?? '',
        event_id: e.id ?? '',
        markets: (e.markets ?? []).map((m) => ({
          condition_id: m.conditionId ?? '',
          question: m.question ?? '',
          outcome_prices: m.outcomePrices ?? '',
          volume: m.volume ?? 0,
        })),
      }))
      return JSON.stringify({ query: args.q, count: events.length, events: summary }, null, 2)
    },
  })), 'dsh-polymarket: search tool')

  // 2) 市场详情（Gamma 元数据 + CLOB tokens + 双方中点价）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'polymarket_get_market',
    description: '查询单个预测市场详情（元数据 + 双 token + 最新中点价）',
    parameters: {
      condition_id: { type: 'string', required: true, description: '市场条件 ID（search 结果里的 condition_id）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: MarketArgs) {
      const cid = args.condition_id
      const gamma = (await fetchJson(gammaBase, `/markets?condition_ids=${encodeURIComponent(cid)}`, timeoutMs)) as Array<Record<string, unknown>>
      const clob = (await fetchJson(clobBase, `/markets/${cid}`, timeoutMs)) as {
        tokens?: ClobToken[]
        market?: string
      }
      let midpoints: Record<string, string> = {}
      const tokens = clob.tokens ?? []
      for (const t of tokens) {
        try {
          const mp = (await fetchJson(clobBase, `/midpoint?token_id=${t.token_id}`, timeoutMs)) as { midpoint?: string }
          midpoints[t.outcome] = mp.midpoint ?? ''
        } catch { /* 单侧中点缺失不阻断整体 */ }
      }
      return JSON.stringify({
        gamma: gamma[0] ?? null,
        clob_tokens: tokens.map((t) => ({ outcome: t.outcome, token_id: t.token_id })),
        midpoints,
      }, null, 2)
    },
  })), 'dsh-polymarket: market tool')

  // 3) 订单簿（CLOB /book，按侧查深度）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'polymarket_get_orderbook',
    description: '查询市场订单簿（买卖盘深度，按 yes/no 侧）',
    parameters: {
      condition_id: { type: 'string', required: true, description: '市场条件 ID' },
      side: { type: 'string', enum: ['yes', 'no'], description: '查询哪一侧（默认 yes）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: BookArgs) {
      const side = args.side ?? 'yes'
      const tokenId = await tokenIdFor(clobBase, timeoutMs, args.condition_id, side)
      const book = await fetchJson(clobBase, `/book?token_id=${tokenId}&side=${side === 'yes' ? 'buy' : 'sell'}`, timeoutMs)
      return JSON.stringify({ condition_id: args.condition_id, side, book }, null, 2)
    },
  })), 'dsh-polymarket: book tool')

  // 4) 最新价格（CLOB /price + /midpoint）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'polymarket_get_price',
    description: '查询市场最新价格（最新成交价 + 中点价，按 yes/no 侧）',
    parameters: {
      condition_id: { type: 'string', required: true, description: '市场条件 ID' },
      side: { type: 'string', enum: ['yes', 'no'], description: '查询哪一侧（默认 yes）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: PriceArgs) {
      const side = args.side ?? 'yes'
      const tokenId = await tokenIdFor(clobBase, timeoutMs, args.condition_id, side)
      const price = await fetchJson(clobBase, `/price?token_id=${tokenId}&side=${side === 'yes' ? 'buy' : 'sell'}`, timeoutMs)
      const midpoint = await fetchJson(clobBase, `/midpoint?token_id=${tokenId}`, timeoutMs)
      return JSON.stringify({ condition_id: args.condition_id, side, price, midpoint }, null, 2)
    },
  })), 'dsh-polymarket: price tool')

  // 5) 历史价格（CLOB /prices-history，interval 或 startTs/endTs）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'polymarket_get_price_history',
    description: '查询市场历史价格序列（OHLC 分时，供图表/趋势分析）',
    parameters: {
      condition_id: { type: 'string', required: true, description: '市场条件 ID' },
      interval: { type: 'string', enum: ['1h', '6h', '1d', 'all'], description: '聚合粒度（默认 1d）' },
      fidelity: { type: 'integer', description: '每根 K 线分钟数（如 1440=日线；缺省按 interval 映射）' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args: HistoryArgs) {
      const interval = args.interval ?? '1d'
      // fidelity 必须与 interval 配套（单独传 fidelity 报 400）；缺省按粒度映射
      const fidelity = args.fidelity ?? (interval === '1h' ? 60 : interval === '6h' ? 360 : 1440)
      const tokenId = await tokenIdFor(clobBase, timeoutMs, args.condition_id, 'yes')
      const history = await fetchJson(
        clobBase,
        `/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`,
        timeoutMs,
      )
      return JSON.stringify({ condition_id: args.condition_id, interval, fidelity, history }, null, 2)
    },
  })), 'dsh-polymarket: history tool')

  // ── 高性能引导：首轮锚定（5 工具面偏大，默认启用核心入口）────────────
  // 机制：system-prompt/assemble 是 Waterfall（必须 await next() 再裁剪）；
  // 会话无任何持久化 tool/call 前，只保留 search 入口；首个工具调用落地后
  // 恢复全部。阶段从持久 session events 推导，resume/reload 不丢状态。
  // 若与其它插件同面竞争首轮注意力，可改为只保留本插件核心工具并放开全量：
  //   ctx.on('system-prompt/assemble', async (_assembly, context: any, next) => {
  //     const assembled = await next()
  //     const agent = context.agent
  //     if (!agent || agent.session.events.some((e: any) => e.type === 'tool/call')) return assembled
  //     const MINE = new Set(['polymarket_search_markets', 'polymarket_get_market',
  //       'polymarket_get_orderbook', 'polymarket_get_price', 'polymarket_get_price_history'])
  //     const CORE = 'polymarket_search_markets'
  //     return { ...assembled, tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE) }
  //   })
}
