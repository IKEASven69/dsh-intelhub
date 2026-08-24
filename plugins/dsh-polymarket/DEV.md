# dsh-polymarket 开发文档

> 2026-08-18 建立，2026-08-23 更新（P1/P2 完成）。目标：记录验证基线、装配机制与下一步开发路线，新会话直接从「开发路线」开工。

## 一、现状快照（2026-08-23 验证基线）

- **v0.1.0**，5 个只读工具全部实现并已装配 web profile（`~/.dsh/profiles/web`，link: junction）
- 三层冒烟**全部通过**（2026-08-23 实测，走本机代理）：
  - `host-smoke`：5 个 handler 真实 API 调用，JSON 无损往返 ✓（history 断言：25 点）
  - `client-smoke`：登录/未登录两种状态渲染 ✓
  - `smoke`（全链路）：cordis 注册 5 工具 → 真实 API 搜索→详情→订单簿→价格→历史 ✓（实测市场：2026 中期参议院，mid 0.495，history 25 点）
- 首轮锚定已启用（见开发路线 2）
- 源码 `src/index.ts`（工具面）+ `src/host-half.js` / `src/client-half.js`（浏览器 UI 半包）
- 目录：`D:\coding\dsh-plugin\plugins\dsh-polymarket`（2026-08-21 随仓库英文化从 `自己的/` 改名）

## 二、网络前提（重要）

Polymarket API（gamma-api / clob.polymarket.com）**直连不通**，必须走本机代理（Clash 系，`127.0.0.1:7897`）。

Node ≥24 的 fetch 默认**不读**代理环境变量，跑冒烟/本地调试要加：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/smoke.mjs
```

dsh web 由宿主进程发起请求时同理受此限制——若 web 里工具超时，先查代理是否在跑。

## 三、验证体系（改代码后按序跑）

```bash
cd D:\coding\dsh-plugin\plugins\dsh-polymarket

# 1. 宿主半包：5 handler + 真实 API（需代理，见上）
node scripts/host-smoke.mjs

# 2. 浏览器半包：mock 求值环境，双登录态渲染
node scripts/client-smoke.mjs

# 3. 全链路：cordis Context 注册 + 真实 API 串链
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node --experimental-vm-modules scripts/smoke.mjs

# 4. 装配验证（无需启动 web）：应看到 `# == dsh-polymarket` 段
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

## 四·二、侧边栏行情面板（client/client.js，2026-08-24 最新态）

「边看边展示」的 UI 半：`shell.overlay` 右侧可拖宽面板（300~720px，默认 360），静态客户端模块（`window.__ModuleLoader__.load` 注册，无需 agent 运行）。

- **浏览器直连** Gamma（搜索/元数据/热门）+ CLOB（**实时中间价/订单簿/历史**）——均实测 `Access-Control-Allow-Origin: *`，不走 host.call
- **默认页=热门榜（官方首页同款）**：`order=volume` 全时量排序出旗舰市场（2028 大选等）；**分类 tab** 全部/政治/体育/加密/文化(`pop-culture`)/经济(`economics`)，`tag_slug` 过滤，选择持久化。已结算过滤：`closed` 或价格 ±2% 跳过，事件全死不进榜
- **价格=CLOB 实时**：列表加载后 `POST /midpoints` 批量拉可见市场+自选（Gamma `outcomePrices` 是缓存价会滞后官网——「数据对不上」的根因）；失败回退缓存价；第二方价实时模式取 `1-p0`
- **官方风格视觉**：事件横幅图（`e.image`）+ 渐变叠标题 + 24h 量徽标；卡片=48px 缩略图（`market.image`）+ 两行问题 + **22px 品牌蓝 #1652F0 大号概率** + 细概率条；详情页=横幅 + 32px 巨号价格
- **数据形状**：`marketSides()` 解析 `outcomes/outcomePrices/clobTokenIds`——体育市场 outcomes 是队名非 Yes/No，显示必须用真实队名（`TEAM VISION 43%`）
- 功能全表：自选★（localStorage 存 tid0/img，随批量实时价刷新）· 🎯跟随会话（`ctx.sessions.currentProvideInfo → hooks.session` 快照，从 assistant 节点 tool-call 块的 name/argsRaw 提取最近一次 polymarket 调用：search 自动切词、带 condition_id 自动进详情；手动搜索即暂停）· 走势 hover 十字线（价格+时间）· 窗口切换 1h/1d/1w/all · 拖宽 · 头部「官网 ↗」直达 polymarket.com（iframe 被 frame-ancestors 封禁，直达是唯一合规形态）· `inject=['slots','sessions']`，sessions 不可用时跟随优雅降级
- 改动生效：**重启 web + 刷新页面**（清单嵌首页 HTML，rev 自动更替）

## 五、开发路线（按优先级）

1. ~~**P1 · price_history 点数异常**~~ ✅ 2026-08-23 修复：实测确认 `interval` 是回看时间窗（1d=最近一天）而非聚合粒度，`fidelity` 才是 K 线粒度；缺省映射改为按窗口配平（1h→5、6h→30、1d→60、1w→360、all→1440），枚举补 `1w`（`1max` 非法返回空，全历史用 `all` 实测 380 点）。默认参数 2 点 → 25 点；smoke/host-smoke 均加「点数 > 10」断言
2. ~~**P2 · 首轮锚定启用**~~ ✅ 2026-08-23 启用：src/index.ts 末尾 system-prompt/assemble Waterfall，首轮只露 search_markets，首个 tool/call 后恢复全部；阶段从持久 session events 推导，resume/reload 不丢
3. ~~**P2 · 超时错误提示**~~ ✅ 2026-08-23：两份 fetchJson 的连接失败/超时错误均追加「受限网络需配置代理」指引
4. **P3 · 新工具**：候选——`list_events`（热门事件榜）、`get_market_by_slug`（人类可读 slug 入口）。保持只读边界。
5. **P3 · 发布**：npm 包化（去掉 private、补 README.en）或提交 dsh 社区市场。「DSH 生态首个 Polymarket 插件」的先发叙事值得抢时间窗。

## 五·二、错题记录

### 2026-08-23 — interval 语义误读导致历史价格只有 2 个点
- 现象：`interval=1d` 默认只返回 2 个数据点，无法画趋势
- 根因：把 CLOB `/prices-history` 的 `interval` 当聚合粒度用（1d 配 fidelity=1440 日 K），实测它是**回看窗口**；窗口与 K 线同尺寸自然只剩 1~2 点。`1max` 非法（空结果），全历史用 `all`
- 修复：`src/index.ts` 与 `src/host-half.js` 两份实现同步改缺省映射与枚举（host 半顺带补枚举校验）；断言防回归
- 另见：本文件「二、网络前提」

### 2026-08-23 — pnpm 在本目录安装 404（dsh-type-meta 不在公网）
- 现象：`pnpm install`/`pnpm tsdown` 触发 peer 自动安装，拉 `@deepseek-ai/*` 时 404；且失败安装会清掉 node_modules 的 .bin
- 根因：peerDependencies 声明的宿主包不在公网 registry
- 修复：本目录补 `pnpm-workspace.yaml`（`autoInstallPeers: false` + esbuild 放行，同 dsh-hippo 先例）；`pnpm install` → `node scripts/link-deps.mjs` → `pnpm build` 恢复正常

### 2026-08-23 — scoped 包名 + link: 安装进不了 client-modules 清单（侧边栏不加载的根因）
- 现象：`dsh.client` 声明齐全、exports 正常、bundle 存在，但 `/client-modules` 清单始终没有本插件，浏览器侧栏面板不加载
- 根因：client-modules 的 Node 半（`@deepseek-ai/dsh-client-modules`）按 loader entry 名解析包，**scoped 名（`@dsh-external/dsh-polymarket`）+ link: junction 安装**的组合被判负（对照：scoped+npm 装的 modlens 能进、link: 装的非 scoped depsec/brain 能进，唯 scoped+link 不行）；负判定整个进程生命周期缓存不重试
- 修复：包名改非 scoped `dsh-polymarket`（同步 cordis.patch.yml、profile 依赖键、bundles），重装 junction 后立即入清单。`@dsh-external` scope 非自有，npm 发布本来也得改名；`private: true` 一并移除
- 教训：第三方插件包名用非 scoped 或自有 scope；client 面板不加载先查 `http://127.0.0.1:3080/client-modules` 清单再查代码

## 六、已知坑

- pnpm 11 supply-chain policy 拒绝未满 release-age 的依赖 → profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude` 放行（已有先例）
- `lib/` 在 .gitignore 里（构建产物）：新 clone 后必须先跑 link-deps + tsdown，否则 link: 装配指向的 lib 不存在
- 构建依赖根目录的 `D:\coding\deepseek-harness` checkout（官方仓库，故意不迁入 dsh-plugin）
- token 双体系：Gamma 用 `conditionId`（0x），CLOB 用 `token_id`（十进制），插件内部自动转换，对外统一 `condition_id`
