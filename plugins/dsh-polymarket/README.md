# dsh-polymarket

[![npm](https://img.shields.io/badge/npm-dsh--polymarket-3b82f6)](https://www.npmjs.com/package/dsh-polymarket)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-000?logo=data:image/svg%2bxml;base64,)

**Polymarket 预测市场行情插件 for DeepSeek Harness（dsh）**——5 个只读 agent 工具 + 右侧「边看边展示」行情侧栏。DSH 生态首个 Polymarket 原生插件。

## 安装

```sh
dsh plugin --profile web add dsh-polymarket
```

重启 dsh web 即可。无需 API key、无需账号（只读公共行情）。

## 一、agent 工具（5 个只读）

| 工具 | 说明 |
|---|---|
| `polymarket_search_markets` | 搜索市场（`q` + 标签/状态/排序/分页） |
| `polymarket_get_market` | 市场详情（结果、规模、事件元数据） |
| `polymarket_get_orderbook` | 订单簿（buy/sell 各 20 档） |
| `polymarket_get_price` | 实时中间价 |
| `polymarket_get_price_history` | 价格历史（窗口 1h/6h/1d/1w/all，K 线粒度自动配平） |

安全边界：全部 GET 只读，无下单/交易能力。token 双体系（Gamma `conditionId` ↔ CLOB `token_id`）内部自动转换，agent 只感知 `condition_id`。首轮锚定：新会话首轮只露 `search_markets` 一个入口，首个工具调用后恢复全部。

## 二、行情侧栏（浏览器半）

右侧边缘「行情」浮动按钮（Polymarket 官方标志），点开 360px 可拖宽面板：

- **热门榜**：24h 成交量排序的活跃事件，打开即见，30s 自动刷新；已结算市场自动过滤，体育赛事显示真实双方（`TEAM VISION 43% / Team Spirit 57%`）
- **搜索**：任意主题收窄，清空回车回热门
- **自选 ★**：常盯的市场固定在顶部，随轮询刷新
- **详情**：中间价 + 买卖盘 + 概率条 + 价格走势折线（1h/1d/1w/all 切换，悬停十字线看价格），一键跳官方市场页
- **🎯 跟随会话**：agent 调工具查什么市场，侧栏自动跟着展示——左边聊、右边看

受限网络（如中国大陆）需配置系统代理：dsh web 启动时带 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897`（或等价代理）。

## 技术

- 静态 Cordis 插件：host 半 tsdown 自包含打包（零外部依赖），浏览器半 `__ModuleLoader__` 注册
- 浏览器直连 Gamma/CLOB API（均 `Access-Control-Allow-Origin: *`）
- MIT 许可的接口语义实测结论与开发文档见 [DEV.md](./DEV.md)（含错题记录）

## License

MIT
