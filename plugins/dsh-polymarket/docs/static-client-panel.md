# dsh-polymarket 静态 client 面板改造方案

> 状态：草案（待确认）
> 日期：2026-08-20
> 背景：5 个只读工具（静态 bundle）已验证通过；client 面板（"Polymarket 行情"卡片）当前**未装配**——代码存在（`src/client-half.js`）但形态是动态 cordis 插件（`code.client` 函数体字符串），需 agent 用 `cordis_define` 动态注入才显示。本方案将其改造成 agentforge-brain 同款**静态装配**形态。

## 一、现状

### 1.1 已验证的事实（2026-08-20）

- 工具面（host 半）：5 个工具 `search_markets / get_market / get_orderbook / get_price / get_price_history` 经 `cordis.patch.yml` insert 装配到 web profile，真实 API 数据返回正常（走本机代理 7897）。
- 面板代码：`src/client-half.js`（146 行）渲染 `MarketCard`（"Polymarket 行情"卡片：登录态徽标 + 默认搜 "president" 拉 5 个事件列表），挂载点 `tool.view.cordis` slot key=`self`，数据走 `host.call('polymarket_search_markets', ...)`。
- **根因**：`client-half.js` 文件头注释明说"本文件内容就是 cordis 插件「函数体」字符串——宿主把它包进 `new Function(...)`"，即**动态 cordis_define 专用形态**。构建产物 `lib/index.js`（265KB）只打包工具面（grep 无 MarketCard），`cordis.patch.yml` 只 insert 插件行——面板从未被装配，UI 中无 dpm-card。

### 1.2 先例：dsh-agentforge-brain（✅ 静态面板样板）

- 挂一个 3D memory-brain tab（`conversation.view` 内），静态装配生效，`/plugins/dsh-agentforge-brain/client.js` 实测 HTTP 200。
- package.json 关键声明：

```jsonc
"exports": {
  ".": "./index.js",
  "./client": "./client.js"   // ← client 半入口
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation"],
    "platform": "web"
  }
}
```

- host 半（index.js）为空壳（仅 `export const name` + 空 `apply`），只为让 Loader 挂载。
- client.js 通过 `window.__ModuleLoader__.load({ id, factory })` 注册（打包产物，非源码）。

### 1.3 侧边栏 slot 真实存在

`ui-layout` 的 `AppFrame.tsx` 三栏布局：`sidebar | conversation | details`，侧边栏即 `renderSlot('sidebar', ...)`。其他落点：`shell.overlay`（悬浮层）、`settings.section`（设置页）、`settings.trigger`（侧栏底部触发按钮）。

## 二、目标形态（建议）

**P0（默认）· conversation.view tab**：与 agentforge-brain 完全同构，风险最低（先例完整可抄）。

**P1（可选）· sidebar 常驻面板**：挂在侧边栏，任何会话常驻可见，贴近"面板查看 polymarket"的直觉；但侧边栏 slot 的 owner props 约束（collapsed/width）需额外适配，无现成第三方先例。

**P2（可选）· settings 页面**：挂在设置面板（`settings.section`），最不打扰主界面。

## 三、改造步骤（照 agentforge-brain 样板）

### 步骤 1：client 源码改造

把 `src/client-half.js` 从"cordis 插件函数体"改造成**静态 client 模块**：

1. 顶部不再写 `return { name, inject, apply }` 插件对象，改为导出 React 组件 `MarketCard`。
2. 保留现有 UI 逻辑（登录徽标、事件列表、host.call 数据通路）——这些与装配形态无关，可复用。
3. 样式注入从 `styles.insert()` 改为组件内 `<style>` 或 CSS 模块（静态 bundle 有正常打包链，不需要动态 styles 注入）。
4. 落点从 `ctx.slots.inject('tool.view.cordis', key='self')` 改为在应用挂载时调用 `ctx.slots.register({ name: 'conversation.view' }, MarketCard)`（P0）或 `ctx.slots.register({ name: 'sidebar' }, MarketCard)`（P1）。

### 步骤 2：package.json 补声明

```jsonc
"exports": {
  ".": "./lib/index.js",
  "./client": "./client.js",   // 新增
  "./package.json": "./package.json"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-conversation"   // P1 改 ui-layout（sidebar 属 ui-layout 域）
    ],
    "platform": "web"
  }
}
```

`files` 数组补 `client.js`。

### 步骤 3：client 构建产物

新增 client 打包链（tsdown 或 esbuild），输出 `client.js`，格式对齐 agentforge：`window.__ModuleLoader__.load({ id: 'dsh-polymarket', factory: ... })`。建议新增 `scripts/build-client.mjs`，并入 `pnpm build`。

### 步骤 4：host 半对齐

`src/index.ts` 目前是工具面（272 行，5 工具），保持不变即可——不需要空壳化（agentforge 空壳是因为它无 host 行为；polymarket 有 5 个工具，两者共存没问题）。

### 步骤 5：验证

```bash
# 1. 构建 + 类型检查
node scripts/link-deps.mjs && pnpm tsdown && pnpm tsc --noEmit

# 2. 冒烟（host 半不受影响，仍走代理）
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/smoke.mjs

# 3. client 冒烟：新增 client-smoke 适配静态形态（mock __ModuleLoader + slot register）
node scripts/client-smoke.mjs

# 4. 重启 web（PID 27724 需终止，带代理 env + overlay patch 重启）
# 5. 浏览器验证：面板出现在预期落点 + 卡片数据加载（host.call 走代理）
```

## 四、待确认决策点

| # | 决策 | 选项 | 我的建议 |
|---|------|------|---------|
| 1 | 落点 | conversation.view tab / sidebar 常驻 / settings 页 | P0 先做 conversation.view tab（与先例同构，风险最低）；sidebar 作为 P1 追加 |
| 2 | 数据源 | 沿用 host.call（走工具 handler）/ 客户端直连代理 | 沿用 host.call（与现有工具面同通路，避免浏览器端代理配置） |
| 3 | 默认查询 | 保持 "president" / 改为可配置 | 保持默认 + 加一个可交互搜索框（可选增强） |
| 4 | 面板交互 | 只读列表 / 点击展开详情（host.call get_market） | 只读列表先上，点击详情 P2 |

## 五、风险与注意

- **slot 声明冲突**：`conversation.view` / `sidebar` 均可能已有 occupant；需先 `cordis_inspect_list` 确认当前占用，避免 priority 冲突（root slot 的 shadow 陷阱在注释里被点名警告，sidebar 是 list slot 无此问题，但仍需确认）。
- **client 构建链**：tsdown 当前配置面向 node 宿主打包，client 需要浏览器 target（esbuild platform=browser）——需加一份独立 client tsdown/esbuild 配置。
- **pnpm supply-chain**：无新依赖（零外部依赖承诺保持），不受影响。
- **目录迁移敏感**：`lib/` 在 .gitignore（构建产物），新 clone 需先 link-deps + build——client.js 属构建产物，同样不提交。
- **代理**：面板 host.call 走宿主进程发起请求，与工具面同受 `NODE_USE_ENV_PROXY=1` 限制（已在 DEV.md 记录）。

## 六、工作量估算

| 阶段 | 内容 | 估计 |
|------|------|------|
| 步骤 1-2 | client 源码改造 + package.json | 0.5-1h |
| 步骤 3 | client 构建链 | 0.5h |
| 步骤 5 | 验证 + 重启 + 浏览器实测 | 1h |
| 合计 | | ~2-2.5h |

## 七、验收标准

1. `pnpm build` 产出 `lib/index.js` + `client.js`，`tsc --noEmit` 通过。
2. 重启 web 后 `/plugins/dsh-polymarket/client.js` 返回 200。
3. 浏览器中目标落点出现 "Polymarket 行情" 卡片，事件列表加载真实数据（经代理）。
4. 5 个工具不受影响（回归 smoke 通过）。
5. 无需 agent 动态 cordis_define，面板随 web 启动即存在。