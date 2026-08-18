# dsh-polymarket 开发文档

> 2026-08-18 建立。目标：记录验证基线、装配机制与下一步开发路线，新会话直接从「开发路线」开工。

## 一、现状快照（2026-08-18 验证基线）

- **v0.1.0**，5 个只读工具全部实现并已装配 web profile（`~/.dsh/profiles/web`，link: junction）
- 三层冒烟**全部通过**（当日实测，走本机代理）：
  - `host-smoke`：5 个 handler 真实 API 调用，JSON 无损往返 ✓
  - `client-smoke`：登录/未登录两种状态渲染 ✓
  - `smoke`（全链路）：cordis 注册 5 工具 → 真实 API 搜索→详情→订单簿→价格→历史 ✓（实测市场：2026 中期参议院，mid 0.495）
- 源码 `src/index.ts`（272 行工具面）+ `src/host-half.js` / `src/client-half.js`（浏览器 UI 半包）
- 目录：`D:\coding\dsh-plugin\自己的\dsh-polymarket`（2026-08-18 从根目录迁入，所有绝对路径引用已修复）

## 二、网络前提（重要）

Polymarket API（gamma-api / clob.polymarket.com）**直连不通**，必须走本机代理（Clash 系，`127.0.0.1:7897`）。

Node ≥24 的 fetch 默认**不读**代理环境变量，跑冒烟/本地调试要加：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/smoke.mjs
```

dsh web 由宿主进程发起请求时同理受此限制——若 web 里工具超时，先查代理是否在跑。

## 三、验证体系（改代码后按序跑）

```bash
cd D:\coding\dsh-plugin\自己的\dsh-polymarket

# 1. 宿主半包：5 handler + 真实 API（需代理，见上）
node scripts/host-smoke.mjs

# 2. 浏览器半包：mock 求值环境，双登录态渲染
node scripts/client-smoke.mjs

# 3. 全链路：cordis Context 注册 + 真实 API 串链
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node --experimental-vm-modules scripts/smoke.mjs

# 4. 装配验证（无需启动 web）：应看到 `# == @dsh-external/dsh-polymarket` 段
node "D:\coding\deepseek-harness\apps\cli\lib\bin.js" web --dump-config

# 5. web 实测：重启 dsh web（junction 链接，改码后无需重新 add，但要重启清 ESM 缓存）
```

## 四、构建与装配

```bash
node scripts/link-deps.mjs   # 从 D:/coding/deepseek-harness junction 构建依赖（缺省路径，可用 DSH_CHECKOUT 覆盖）
pnpm tsdown                  # 自包含打包 → lib/index.js（约 265KB，零外部依赖，任何路径可装配）
pnpm tsc --noEmit            # 类型检查
```

装配机制要点（详见 SKILL.md）：

- `dsh plugin --profile web add "link:<绝对路径>"` = profile 目录 pnpm add + reconcile
- 进 `dsh.profile.bundles` 层的条件：package.json 声明 `dsh.bundle.patch: "./cordis.patch.yml"`
- link: 协议 = junction，改代码即时生效，但**新增/删除文件和 ESM 缓存需重启 web**
- profile 的 `package.json` 里 link 路径是**绝对路径**——本插件目录再搬家时必须同步改 `~/.dsh/profiles/web/package.json` 并 `pnpm install`（2026-08-18 迁移时已处理）

## 五、开发路线（按优先级）

1. **P1 · price_history 点数异常**：实测 `interval=1d&fidelity=1440` 只返回 2 个点，活跃数月的市场应有几十根日 K。排查 CLOB `/prices-history` 参数（可能需 startTs/endTs 或 fidelity 映射有误）。修法：smoke.mjs 加断言（点数 > 10）防回归。
2. **P2 · 首轮锚定启用**：`src/index.ts` 末尾注释里有完整方案（system-prompt/assemble Waterfall，首轮只露 search_markets）。5 工具面偏大，建议启用；启用后 client/smoke 需补锚定场景测试。
3. **P2 · 超时错误提示**：`fetchJson` 超时抛错不含代理提示，web 用户会看到裸 ConnectTimeout。错误信息加一句「检查代理」。
4. **P3 · 新工具**：候选——`list_events`（热门事件榜）、`get_market_by_slug`（人类可读 slug 入口）。保持只读边界。
5. **P3 · 发布**：npm 包化（去掉 private、补 README.en）或提交 dsh 社区市场。「DSH 生态首个 Polymarket 插件」的先发叙事值得抢时间窗。

## 六、已知坑

- pnpm 11 supply-chain policy 拒绝未满 release-age 的依赖 → profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude` 放行（已有先例）
- `lib/` 在 .gitignore 里（构建产物）：新 clone 后必须先跑 link-deps + tsdown，否则 link: 装配指向的 lib 不存在
- 构建依赖根目录的 `D:\coding\deepseek-harness` checkout（官方仓库，故意不迁入 dsh-plugin）
- token 双体系：Gamma 用 `conditionId`（0x），CLOB 用 `token_id`（十进制），插件内部自动转换，对外统一 `condition_id`
