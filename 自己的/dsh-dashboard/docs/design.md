# 活动仪表盘 + IM 桥接 — 功能点与落地方案全记录

> 本文记录本轮对话中讨论过的**所有**功能点、已实现状态、技术选型结论与后续落地计划。
> 动态插件是进程内对象，重启即失；本文是唯一持久的蓝本。代码蓝本见 `docs/blueprint.md`。

---

## 0. 现状快照

| 对象 | 状态 | 说明 |
|------|------|------|
| `dash-1` (活动仪表盘) | **运行中** `pkg-28` | host + client 双半，已修复多次丢 client 的问题 |
| `imbr-2` (IM 桥接) | **运行中** `pkg-27` | workspace/session 分离 + 网页聊天 + 飞书推送 |
| `docs/blueprint.md` | 持久 | 长期化改写蓝本 |
| 本文档 | 持久 | 全量功能点记录 |

> 注意：动态插件进程内有效，重启进程后需要按蓝本重新 `cordis_define` / `cordis_run`。

---

## 1. 已实现功能（dash-1 / imbr-2）

### 1.1 活动监视器 (Activity Monitor)
- 监听 `session/event`、`agent/status`、`subagent/start|end`、`workflow/start`、`agent/error`、`tools/result`。
- 展示：会话事件流、agent 状态、子代理启停、工作流启动、工具调用结果、错误。

### 1.2 Token 消耗 + 峰谷电价 CNY 成本
- 数据源：`sessionProjections.snapshot(session).values.{tokenUsage, contextPressure, contextBreakdown, sessionStats}` + `tokenMeter.measure(session)`。
- 模型探测：`agentDefaultModel.currentSelection().model`。
- 计价：DeepSeek v4-flash / v4-pro，北京时区峰时 9–12 / 14–18，生效 2026-08-17。
- 规则：cache-write 按 cache-miss 价计；峰谷表**内置计算，不展示完整价表**（用户要求）。
- 展示：峰时/谷时费用、累计 CNY。

### 1.3 Skill 雷达 (Skill Radar)
- 数据源：`skills.list()` → `[{name, description}]`。
- 展示：已加载技能 + 下一技能预测（基于 description 语义/启发式）。

### 1.4 上下文压力趋势 + ACP 分析
- 数据源：`sessionProjections` 的 `contextPressure` / `contextBreakdown`。
- 展示：压力曲线、构成拆解、压缩可回收空间提示（对应 §2 的 ACP 思想）。

### 1.5 每 agent 成本归因 (Per-agent cost attribution)
- 从 `agents.list()` / `sessions.list()` / 各 agent session 的 token 投影汇总，按 agent 归因 token 与成本。

### 1.6 编排拓扑 (Orchestration Topology)
- 从 `agents` 树（roots/get）+ `subagent/start|end` + `workflow/start` 推导父子关系图。

### 1.7 压缩摘要面板 (Compaction Summary Panel)
- 监听 `compaction/summary`（data: `summary:ContentBlock[]`、`shadowedRange{start,end}`、`shadowedTokenCount`、`provider/model`）。
- 展示：压缩摘要、被遮蔽区间、回收 token 数、所用模型。
- 提供 `compact_now` 工具（output schema 已修 `additionalProperties:false` + 逐属性 `required:true`）+ 面板按钮，调用 `compaction.compactNow(agent, signal)`。

### 1.8 CLI 启动器 (CLI Launcher)
- 交接（handoff）到 opencode / pi / codex / Claude Code。
- 用 `shell.start`（后台 `ShellProcess`）+ 自建追踪 + `kill-cli`，**不用** `AbortController`（host 受限环境无此全局）。
- `exec.signal` 是动态 host 里唯一能拿到真 `AbortSignal` 的地方。

### 1.9 高危命令自拦截 (High-risk guard)
- 挂 `tools/pre-execute`（waterfall，返回 `{kind:'allow'|'deny'|'ask'}`）。
- **只**作用于命令执行类工具（pwsh/bash/shell/subprocess/terminal），**不**对 JSON args 做 fallback 匹配 —— 否则会误锁自身源码里的 "rm -rf"（曾发生：拦截 `cordis_define` 自己）。

### 1.10 外部桥接 (External Bridge)
- 通过 `webServer.register({kind:'exact'|'prefix', path, handler})` 暴露 JSON / NDJSON / SSE 端点。
- **必须**包在 `ctx.effect(() => webServer.register(...))` 里，否则 update 时旧路由不回收 → 重复注册报错 → 路由落到 SPA fallback（曾发生，`/dsh-dash/stream` 404）。

### 1.11 IM 桥接 (imbr-2)
- 网页聊天页 + 二维码 / 局域网交接（QR/LAN handoff）。
- 飞书单向推送（群自定义机器人 webhook）。
- workspace 与 session 分离、session 列表/切换。
- 路由：`/dsh-im/{info,switch,stream,send,feishu}`。

---

## 2. billion-context-pi 源码研读结论 + 引入决策

> 用户要求：先读源码，再决定如何"真正引入"（此前只是贴了个 ACP 概念标签，未落地）。

### 2.1 它到底做了什么（读完源码后的结论）

ACP（Active Context Pruning）不是"硬截断"，是**模型驱动的结构化压缩**，核心分四块：

1. **消息引用标签 (ref tags)**：每条 user/tool 消息末尾注入 `<acp tokens="2.1K" type="bash">m00175</acp>`（XML，源码用 `\x3c/\x3e` 十六进制转义防被编辑工具剥离）。assistant 消息不打标签（防模型回显）。见 `messages.ts` 的 `patchRefTag` / `peelRefTagBlocks`。
2. **模型自写摘要的压缩工具 (compress)**：模型用 `compress({content:[{startId,endId,summary,topic?}]})` 把一段区间替换成自己写的 dense 摘要（保留结论/文件路径/决策/精确值）。不是系统生成的摘要，是**模型在思考后自己决定压什么、写成什么**。`compress-tool.ts` → `runtime.core.applyCompression`。
3. **多级压缩 (T1→T2→T3)**：摘要会累积；T1 摘要多了，系统注入 nudge 提示把旧 block 蒸馏成 T2，再多了蒸馏成 T3。压缩块可用 blockId 当边界再次压缩（`startId:"b3", endId:"b15"`）。状态持久化到每会话 `.acp.json`（`state.ts` 的 `SessionStateStore`）。
4. **可搜索 + 可解压**：`search_context`（关键词搜索压缩块摘要 + 历史消息，返回 ref + 解压命令）、`decompress`（默认写到文件避免上下文膨胀，`inline:true` 才回内联；block 保持压缩态、不破坏缓存前缀）。`search-tool.ts` / `decompress-tool.ts`。

外加两条**正交能力**：

5. **Nudge 注入**：每次 LLM 调用前跑 `core.processTurn`（prune + 打标签 + 判断是否该提示压缩）。上下文过阈值时把一段"该压缩了"的提示**追加为一条 user 消息**（每 turn 去重，emergency ≥80% 不去重）。`index.ts` 的 `wireContextTransform`。
6. **干净上下文委派 (acp_delegate)**：spawn 一个**全新 Pi CLI 进程**（`process.execPath` + 角色 prompt），角色 reviewer/researcher/planner/oracle 只读（`--tools read,bash,grep,find,ls` 白名单）、worker 可写。结果默认落文件，通过 `acp_delegate_wait` 阻塞取 / 完成时注入系统通知。核心价值：**子代理不带主对话上下文，不污染主上下文**。`delegate-tool.ts`。

### 2.2 关键洞察：harness 已经"有 80% 的骨架"

对照 harness 原生能力：

| ACP 概念 | harness 原生等价物 |
|----------|-------------------|
| 区间压缩 + 摘要替换 | `compaction` 服务 `compactNow` + `BasicCompactionEngine`（region 压缩）|
| 被遮蔽区间 | `compaction/summary` 事件的 `shadowedRange{start,end}` |
| 回收 token 数 | `shadowedTokenCount` |
| 上下文压力 | `sessionProjections.snapshot().values.contextPressure` |
| 消息引用 | 会话事件 `seq`（稳定序号，天然可寻址）|
| 干净上下文子代理 | harness 原生 subagent + `sessions.fork` |

**harness 缺的、且 ACP 真正独有的**：
- **模型自写摘要**（harness 的 compaction 摘要也是模型生成的，但触发是系统/命令，模型不"主动"选区间）。
- **多级蒸馏 T1→T2→T3**（harness 是单级 region 替换）。
- **块级搜索索引 + 解压到文件**（harness 有轨迹/会话检索，但没有"压缩块"这一层可寻址对象）。
- **Nudge 哲学**（把"该压缩了"作为一条消息喂给模型，让模型决定）。

### 2.3 引入决策（分两阶段，务实优先）

**阶段 A（务实路，先做）—— 把 harness 原生压缩表面化到仪表盘，不改内核。**
- 仪表盘读原生 `compaction/summary`、`contextPressure`、`contextBreakdown`，做"压缩摘要 + 可回收空间"面板（§1.4 / §1.7 已有雏形）。
- 把 ACP 的**哲学**（哪些该压、哪些不该压、写 dense 摘要）作为仪表盘的"建议/提示"文案，而不是移植算法。
- 收益：零内核改动、纯 native 服务、长期化成本低。

**阶段 B（忠实路，可选，长期化后做）—— 移植 acp-kernel 的模型驱动块压缩为 repo host 插件。**
- acp-kernel 是纯 TS、零运行时依赖、MIT，`createCore`/`processTurn`/`applyCompression`/`searchBlocks`/`collectBlockContent` 接口清晰，可整体 bundling 进一个 host 包。
- 落点：实现一个新的 `CompactionEngine`（继承 `CompactionEngine` 抽象类），或作为独立插件注册 `compress/decompress/search_context/acp_status` 四个工具 + 每会话 block 状态存储（照搬 `SessionStateStore` 思路）+ 监听 `compaction/summary` 对齐 shadowing。
- 需要验证：harness 是否有 Pi 那样"每次 LLM 调用前 transform 消息"的 hook（Pi 是 `context` 事件）。若无等价 hook，忠实路的"标签注入 + 每 turn nudge"降级为"工具驱动的按需压缩 + 面板手动触发"，价值仍保留（多级块 + 可搜索 + 解压到文件）。

> **结论（诚实版）**：ACP 不是"harness 没有的魔法压缩"，它是"压缩治理 UX"层 —— 模型主动、可寻址、多级、可搜索。harness 的 `compaction` 已经做了"压"，缺的是"可寻址/可搜索/多级/模型主动"这套治理体验。**因此真正引入 = 阶段 A 先把原生表面化 + 阶段 B 再补治理层**，而不是推翻 harness 的 compaction。

---

## 3. 仪表盘增强方向（"不止是显示"）

用户诉求：仪表盘要能给用户**有用信息**，做成**自适应增长的信息流 / 外部入口**，并对标 Claude Code 与 Codex 的新能力。

### 3.1 自适应优先级信息流 (Adaptive priority feed)
- 不是固定面板，而是**按重要度排序的事件流**：错误/高危拦截 > 子代理完成 > 压缩事件 > 普通工具调用。
- 规则可启发式：`agent/error`、`tools/pre-execute` deny、`compaction/summary`、`subagent/end` 加权置顶。

### 3.2 智能建议 / Nudge
- 借鉴 ACP nudge 哲学：仪表盘根据 `contextPressure` 过阈值时，给出"建议压缩哪些区间 / 移交哪个子代理"的**可点按钮**（触发 `compactNow` / 委派）。

### 3.3 外部入口面板 (External entry)
- 整合 CLI 交接（§1.8）+ 网页/二维码交接（§1.11）为一个"导出到 X"面板。

### 3.4 Bug / Issue 卡片（对标 Claude Code TaskList）
- 从 `agent/error`、`tools/result` 失败、`subagent` 异常、`session/event` 中的报错**自动聚合成 bug 卡片**：标题、file:line、复现上下文、建议动作。
- 参考 Claude Code 的 TaskList（bug 卡片可追踪、可勾选）。

### 3.5 任务交接入口（对标 Codex 任务式工作区 / 转发上下文）
- Codex 的能力（任务为中心的工作区、`#16145` 转发上下文）对应到 harness：**用 `sessions.fork` / `sessions.open` 把当前会话上下文打包交接给新会话或子代理**。
- 入口做成"交接/转发"按钮：把当前工作移交到干净上下文子代理（对齐 §2.1 的 acp_delegate 思路，但用 harness 原生 subagent/sessions）。

---

## 4. Feishu（飞书）/ ZCode 说明

### 4.1 结论（已与用户对齐）
- ZCode/智谱的"扫码即建机器人"能零配置，是因为它是飞书**注册服务商/ISV**，走服务商代建应用授权流程。
- **自托管无法复刻零配置扫码**。可选两条：
  1. **单向**：群「自定义机器人」webhook —— 真正零配置，只能推不能收（imbr-2 已用此）。
  2. **双向**：创建企业自建应用，最少需要 **App ID + App Secret**（再扫码把机器人加进群）。`process.env` / `crypto` / `ws` 都需完整 Node → **必须落成 repo 插件**，动态插件受限环境做不了双向。
- 用户答复："晚点我再给你这个"（App ID/Secret）→ **双向飞书暂缓，等凭证**。

---

## 5. 长期化（repo 插件）计划

> 用户选了"1"：先把活动仪表盘长期化（单独聚焦任务）。双向飞书是长期化的一部分，但需等凭证。

### 5.1 落点
- client：`packages/client/ui-dashboard`（新建，仿 `ui-sidebar` 骨架）。
- host：新增 `packages/...`（活动聚合 + 计价 + web 路由 + 高危守卫 + CLI 交接）。
- 注册：`tsconfig.client.json` 聚合、`packages/bundle/web-app/cordis.patch.yml`（`dsh.client` 行）、根 `package.json` 依赖、host composition。

### 5.2 骨架（已核对 `ui-sidebar`）
- `package.json` 带 `dsh.client.inject` + `platform:"web"`。
- `tsconfig.json` extends `tsconfig.base.client.json`；`tsdown.config.ts` 用 `clientBundle(...)`。
- `src/index.ts`（node 半）、`src/invariant.ts`、`src/client/apply.ts`、README、Agent Note。

### 5.3 门槛 (gates)
- `pnpm typecheck` / `lint` / `test:gui` / `snapshot` / `doc-sync` 全绿。
- 依赖服务：`agents`、`sessions`、`sessionProjections`、`tokenMeter`、`skills`、`goals`、`sessionTitle`、`jobs`、`shell`、`subprocess`、`webServer`、`sandboxPolicy`、`agentDefaultModel`、`compaction`、`workspaceRegistry`。
- 事件：`tools/pre-execute`、`tools/result`、`session/event`、`agent/status`、`subagent/start|end`、`workflow/start`、`agent/error`、`approval/request`、`compaction/summary`。

### 5.4 三个关键陷阱（蓝本已记，此处重申）
1. 动态插件每次 `cordis_define` **必须同时给 `code.host` 与 `code.client`**（曾丢 client 四次，面板起不来）。
2. web 路由必须 `ctx.effect(() => webServer.register(...))`，否则 update 后路由泄漏/重复。
3. 高危守卫只锁命令执行类工具，且不要 JSON fallback 匹配源码字面量。

---

## 6. 依赖服务 / 事件速查

- **服务**：`agents(list/roots/get/.followup/.runMaintenance)`、`sessions(list/get/.events)`、`sessionProjections.snapshot(session).values.{tokenUsage,contextPressure,contextBreakdown,sessionStats}`、`tokenMeter.measure(session)->{nodes,totalTokens,surfaceTokens}`、`skills.list()`、`goals.get(agent)`、`sessionTitle.get(session).title`、`jobs`、`shell(resolve/run/start; ShellProcess.readOutput()/kill())`、`subprocess`、`webServer(register/registerUpgrade/.port/.host)`、`sandboxPolicy.workspaceRoot`、`agentDefaultModel.currentSelection().model`、`compaction.compactNow(agent,signal)`、`workspaceRegistry.list()`。
- **事件**：`tools/pre-execute`(waterfall allow/deny/ask)、`tools/result`、`session/event`、`agent/status`、`subagent/start|end`、`workflow/start`、`agent/error`、`approval/request`(waterfall)、`compaction/summary`(summary/shadowedRange/shadowedTokenCount/provider/model)。
- **会话日志**：`tool/call` 事件 data = `{turn, step, callId, name, arguments}`；`session.events` 返回全量缓存日志（可扫描历史 skill 加载/压缩）。

---

## 7. 待办优先级（建议）

1. ✅ 读 billion-context-pi 源码 → 已出 §2 决策。
2. ✅ 写全量功能点文档 → 本文件。
3. ⏭️ **长期化 dash-1**（阶段 A：先把原生压缩表面化 + 现有面板迁入 repo 插件）。
4. ⏸️ 双向飞书（等 App ID/Secret）。
5. ⏭️ 仪表盘增强（§3 的 bug 卡片 / 任务交接 / 自适应信息流）—— 长期化后做。
6. ⏭️ 阶段 B：忠实移植 acp-kernel 治理层（多级块 + 可搜索 + 解压到文件），可选。
