---
name: dsh-polymarket
description: Polymarket 预测市场只读行情工具插件（DSH web profile）。5 个只读工具：search_markets / get_market / get_orderbook / get_price / get_price_history。开发与装配工作流入口。
---

# dsh-polymarket

Polymarket 预测市场只读行情工具包，作为 DSH（DeepSeek Harness）插件运行在 `web` profile。

## 能力

5 个只读工具（`src/index.ts`，lib/index.js 265KB 宿主自包含打包）：

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `search_markets` | 搜索市场（唯一入口，锚定 5 个搜索参数） | `q`（必填）+ 标签/状态/排序/分页 |
| `get_market` | 市场详情（结果、规模、事件元数据） | `condition_id` |
| `get_orderbook` | 订单簿（buy/sell 各 20 档） | `condition_id` + `side` |
| `get_price` | 实时中间价 | `condition_id` |
| `get_price_history` | 价格历史（区间采样） | `condition_id` + `interval` + 可选范围 |

只读安全边界：全部走 GET，无下单/交易能力。

## token 双体系

- Gamma API 用 `conditionId`（0x 十六进制）——市场元数据/搜索的自然键
- CLOB API 需要 `token_id`（十进制字符串）——orderbook/price/history 全用十进制 token
- 内部自动做 `conditionId → token_id` 转换（`/markets/{conditionId}` → `tokens[].token_id`），agent 感知不到

## 开发工作流

```bash
# 1. 链接宿主依赖（cordis/schemastery/dsh-tools 的 vendored 副本）
node scripts/link-deps.mjs

# 2. 构建（tsdown 打包为自包含 lib/index.js）+ 类型检查
pnpm tsdown
pnpm tsc --noEmit

# 3. 装配到 web profile（link: 协议 = junction 链接，改代码即时生效）
node "D:\coding\deepseek-harness\apps\cli\lib\bin.js" plugin --profile web add "link:D:\coding\dsh-plugin\自己的\dsh-polymarket"

# 4. 验证装配后的组合配置树（无需启动 web）
node "D:\coding\deepseek-harness\apps\cli\lib\bin.js" web --dump-config
# 应看到 `# == dsh-polymarket` 段

# 5. 重启 web 使插件生效（启动时读 bundles 列表 + ESM 缓存）
#    web 由用户手动启动（vite），重启后工具即注册
```

## 装配机制要点

- `dsh plugin --profile web add <绝对路径>` = 在 profile 目录跑 pnpm add + reconcile
- 只有 package.json 声明 `dsh.bundle.patch: "./cordis.patch.yml"` 的依赖才进入 `dsh.profile.bundles` 层（plugin.ts `exportsPatch` 判定）
- `cordis.patch.yml`（本插件根目录）insert 一行插件行：`{ id: dsh-polymarket, name: 'dsh-polymarket', config: {} }`
- profile：`C:\Users\20369\.dsh\profiles\web`，node_modules junction → 本目录
- 已知坑：pnpm 11 supply-chain policy 会拒绝发布未满 release-age 的包（如用户强制更新的 dshmarket）——在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude` 放行，无需回滚

## 修改代码后

1. `node scripts/link-deps.mjs && pnpm tsdown`（若改了依赖/源码）
2. 重启 web 验证（junction 链接无需重新 add）
