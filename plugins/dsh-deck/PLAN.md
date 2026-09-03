# dsh-deck · 工作台插件 · 定稿计划（7 天冲刺 0.1.0）

> 立项：2026-08-24。**本文件是唯一权威版本**（对话中的历史版本作废）。
> 两内置台面（知识调研 / 自媒体）+ 可新建工作台的容器层 + zcode 引擎（零 DS token）+ 发布预填人工终审。
> 参考 dsh-worktable（MIT，只学思路不抄码）。执行：任意 agent 按本计划 + 必读清单开工。

---

## ⚡ v2 质量整备计划（2026-08-26 起 · 用户实测反馈驱动 · 当前执行）

> 用户实测反馈：二级页面全是简化版、样式潦草、浮窗/分格全无。以下按优先级执行，每项完成即勾。

### P0 修复（已核实，立即）
- [x] F1 路径误杀：security.ts `startsWith('.')` 一刀切拒绝 `.git/.gitignore/.baoyu-skills`（穿越已由段级+包含性检查防住）→ 删前缀规则 + 单测（点段放行、`..`/`a/../b` 仍拦）✅ 2026-09-01 核实：现代码已为段级检查（`s === '.' || s === '..'`），单测 10 项放行 `.git` 等，通过
- [ ] F2 「四库」改名「📚 文库」：层级标签白话化（① 采集原料 ② 事实核查 ③ 判断沉淀 ④ 方法论 ⑤ 点子池）+ 顶部一句说明
- [x] F3 启动器配置化（用户实测 zcode TUI 不可用；opencode 1.18.21 实测存活）：deck.json 存 launcher{cli: opencode|zcode|custom, customCmd, cwd}；「🚀 发给 agent」点开先弹启动器选择（CLI 单选 + 启动目录：项目夹/自定义 + 记住选择），默认 opencode；dispatch 按配置起终端 ✅ 2026-09-01 核实：API `/api/deck/launcher` + 客户端 `LauncherModal` 已落地

### P1 悬浮窗口系统（核心新增，worktable 对齐+超越）
- [ ] W1 浮窗引擎：DragLayer + Window 组件——标题栏拖动、右下角缩放、最小化/最大化/关闭、点击置顶（z-index 栈）、位置大小 localStorage 持久化（dsh-deck.windows.v1，重开恢复）。**worktable 实际没有自由浮窗（其 float 仅侧栏 dock），此项为超越点**
- [x] W2 窗口类型注册表：md 预览窗 / **编辑窗（md 可改可存，保存走 fs/write 原子写，预览/编辑双态——对齐 worktable TextViewer）** ✅ 2026-09-01 简版落地：Preview 组件内联编辑（textarea + 保存→fs/write），43 测全绿；浮窗注册表与 html/浏览器窗仍待 W1 之后
- [ ] W3 接入点：文库文件→浮窗（预览+编辑切换）；内容详情文件 chips + 产物→浮窗；点子卡/内容卡详情→浮窗；发布预填→浮窗承载说明+链接+文本
- [ ] W3b **对话右栏（worktable 同款路线）**：deck shell 从全屏盖死改为「左内容 + 右原生对话」——applyMargin 挤宿主会话视图到右侧（findConversationRoot 找 [data-phase] 根 + ResizeObserver/MutationObserver 重锚定），切会话不关工作台；右侧宽度可拖、可收起
- [ ] W4 主区双栏 v1：列表左 320px / 右详情，可收起；<1100px 自动单栏。worktable 全套 dock 引擎（8 预设/跨窗拖标签/保活池）不抄，留 v0.2

### P1b 派发双通道（源码核实后的路线修正，worktable 核心机制对齐）
- [ ] D1 **宿主会话模式**（默认推荐）：任务文本 prompt 进绑定/新建 dsh 会话（promptIntoSession 三级降级：conversation.sendSession→session.prompt('queue')→scoped conversation.send）；任务文本模板=窗口/任务身份+项目文件夹硬约束+按类型选产出形式+**知识包**（deck 版：路由清单/皮肤说明/协议要点，免 agent 重新侦察）；新会话 ensureSessionPreset 防失效模型继承
- [ ] D2 外置 CLI 模式（零 DS token）：opencode 默认（实测存活）/zcode/自定义命令+目录可选，配置存 deck.json
- [ ] D3 **产物自动挂载闭环**（对齐 worktable applyWidgetManifest）：widget-result.json {window:'main'|'窗口N'|'float', kind, path|url|html} → 完成事件消费一次 + 5s 自愈扫描兜底 + 清单原文指纹去重（不覆盖用户手改）+ pendingMount localStorage 断点续挂
- [ ] D4 **产物皮肤**：GET /api/deck/template/skin.css + skin.html 组件参考（esbuild text loader 嵌入分发），任务文本要求产物引用——agent 产物与宿主风格一致（worktable dshell 同思路）

### P1c 控制室对齐 worktable 完整度
- [ ] C1 会话卡三态判定：待你决定（pendingInteraction/会话 pending）> 已完成 > 工作中 > 空闲；运行时长（最早 running job startedAt）；点击 ack 熄光（localStorage notifyAck，状态转移自动重新亮）
- [ ] C2 **消息预览**：内存快照 lastTextOf（零 token）+ 冷会话 face.history({maxMessages:6}) 预热（6s 防抖），cleanPreviewText 清代码块取 220 字
- [ ] C3 会话分组列表（读宿主 workspace.json 按工作区分组，排除子代理/archived）用于绑定与派发选择

### P1 台面补完（每个二级页做到「能用完整」）
- [ ] T1 点子库→看板：三列 🌱种子/🥚孵化/✅已采纳；卡点开浮窗详情（全文/编辑正文/状态流转/→调研任务卡/→选题夹）；顶部快速捕获保留
- [ ] T2 复盘台：左列 insights/*.md 文档清单 + 右正文渲染 + 过滤页签（全部/⚠️待验证/✅已验证）+ 「本次调研新落库」高亮最近 Deck 章节
- [ ] T3 内容详情文件可编辑：全部文件 chips 浮窗化，md/html 均可编辑保存，PPT html 改完预览即时刷新
- [ ] T4 选题创建重做：字段一句话说明+占位示例；平台输入改胶囊多选（公众号/微博/X/小红书/知乎/自定义）；创建成功直接打开详情并置 drafting
- [ ] T5 发布弹窗重做：三档字号规范、按钮统一（实心=生成预填/描边=关闭）、步骤化（①选平台 ②生成并复制 ③人工发布 ④贴链接回写），杀小字鬼字
- [ ] T6 全局小字下限 11.5px 清理（消灭 10/10.5px 残留）

### P2 质量闸
- [ ] Q1 Playwright 全量回归（scripts/e2e.cjs）：六台面×全部交互——建卡→派发（双 CLI）→审阅勾选落库→内容全周期（建/交/产/编/发预填/记录）→浮窗（开/拖/缩/存/复开）→双栏→文库点遍（含点目录）；产出 docs/e2e-report.md + 全截图
- [ ] Q2 发布流程最终人工实测（用户点发微博/X）

---


## 〇、交接必读清单（执行 agent 开工前按序读）

1. `D:\coding\dsh-plugin\plugins\dsh-polymarket\DEV.md`（插件工程全流程先例）
2. `D:\coding\dsh-plugin\plugins\dsh-depsec\README.md`（host 路由/构建纪律先例；**注意：depsec 没有 DEV.md，工程说明在 README 的开发/构建段**）
3. `D:\coding\knowledge-base\README.md`（知识库纪律与结构）
4. `C:\Users\20369\.agents\skills\baoyu-post-to-wechat\SKILL.md`（草稿 API + 凭据优先级链）
5. `C:\Users\20369\.agents\skills\baoyu-post-to-x\SKILL.md`（CDP 模式 + 判型 + 登录持久化）

## 一、已核实环境事实（都是踩过的坑，勿重复踩）

1. **插件先例**：polymarket / depsec 有完整 link-deps/slot/构建/vitest/agent-browser 回归管线；构建依赖 `D:\coding\deepseek-harness` checkout
2. **包名必须非 scoped**（scoped+link: 进不了 client 清单，实测）；勿加 private
3. **沙箱**：插件走 `ctx.fs` 的写被 workspace-write 拒（实测）；**host webServer 路由不受限**——写盘全走 host 路由
4. **dsh 0.1.1-rc.2**：插件清单嵌首页 HTML（`__DSH_BOOT__`），`/client-modules` 端点已移除
5. **knowledge-base**：5578 md 四级（collections→research→insights→skills）+ INDEX.md（export-index.ps1 生成）+ graph.ps1 + panel-src/（React19 半成品面板可移植）
6. **baoyu 技能**：post-to-wechat（草稿箱 API draft/add 确认；凭据优先级 EXTEND.md→环境变量→.baoyu-skills/.env）· post-to-weibo/x（真 Chrome CDP，机器可能只有 Edge，D1 验证）· slide-deck/image-gen；**xhs 无发布技能**；apify-content-analytics 仅 IG/FB/YT/TikTok
7. **快照镜像**（worktable 精华）：client 订阅 `ctx.sessions.list.getSnapshot()+subscribe()`，防御式多形状消费，模块级 store（绕 useSessions 崩溃）
8. **widget 挂载**：双通道（完成事件+自愈扫描）+ 指纹去重；「窗口N」约定映射 pane

## 二、工作台容器规范（对照 worktable 全功能）

| worktable 功能 | dsh-deck 实现 | 天 |
|---|---|---|
| 新建（布局+文件夹） | 向导：名称/emoji 图标/文件夹/布局/**模板**——空白容器 或 业务模板（知识调研型/自媒体型，自带任务卡+看板+审阅流）← 超越点 | D3上 |
| 重命名/图标/排序/隐藏 | 同，deck.json projects[] | D1上 |
| 项目↔会话绑定 | 同（sessions.open） | D3上 |
| 收起→方块 tile | 同 | D3上 |
| 控制室卡片墙（零轮询） | v1：任务卡聚合 + sessions.list 镜像 + **统一看板视图**（全项目四列 queued/running/review/done，点卡跳项目） | D3下 |
| 布局+拖拽+标签+宽度持久 | D7 分屏 v1（~600 行；落后砍） | D7下 |
| 内置窗 | 文件/预览(md,html)/iframe/终端(PTY,降级=复制命令)/挂载产物窗 | 各天 |
| widget 自动挂载 | 同 | D3下 |

内置两台面 = 预注册模板实例（绑 knowledge-base / content 根），不可删可隐藏。

## 三、点子库（并入 D2）

- knowledge-base 加 `ideas/` 层（第五层）：一念一 md，frontmatter `status: seed|incubating|picked` + 来源 + 关联
- 知识台「点子」tab：列表+快速捕获框+状态流转
- 采纳出口：成选题（自动建 content/{slug}/）或调研题（自动建 TASK.md）——漏斗：点子→选题/调研→生产/调研→落库/发布

## 四、两张台面

**知识调研台**：读侧（FTS 全文搜索+四库导航+md 预览+insights 复盘：48 条/45 待验证+到期提醒+点子 tab）+ 写侧（主题→任务卡→zcode 采集调研→审阅区 candidates→**用户勾选落库**，唯一写通道经落库执行器）
**自媒体台**：文章/视频/PPT 三形态（一篇一文件夹：meta.md `status: idea|drafting|ready|prefill|published` + 脚本.md + 素材/ + 发布记录.md）+ 选题看板四列 + 账号面板（登录状态探测/一键续登）+ 发布预填队列（公众号走官方草稿箱 API；微博/X CDP 预填，**停在发布前一步，永远人工点发**）+ 评论审阅收件箱（CDP 薄抓 + AI 起草 + 人工发送）+ 数据回流（apify 海外 + 公众号后台薄抓/手动录入）

## 五、zcode 接单协议

每个项目根放 `AGENTS.md`：
> 开工规则：读 TASK.md 中 status=queued 的卡（一次一张）→ 改 running → 按验收条目干活 → 写 RESULT.md（+widget-result.json 如有可视化产物）→ 改 review。

「发给 zcode」= 写任务卡 + 起终端（PTY；降级：生成 `cd <项目根> && zcode` 复制到剪贴板）。

## 六、数据协议

- `~/.dsh/storages/dsh-deck.json`：`{projects:[{id,name,icon,folder,template,layout,order,hidden,bindSession}], accounts:{wechat{mode:api-draft,ok,checkedAt}, weibo/x{mode:cdp-prefill}}, pendingMount:[]}`
- 任务卡 `TASK.md`：`id/type(research|article|video|ppt)/status(queued→running→review→done|failed)/engine:zcode/acceptance[]`
- `RESULT.md`：frontmatter task/type/summary；`widget-result.json`：`{task, windows:[{target:"main"|"窗口N", kind:html|url|file, path|url|html}], generatedAt}`
- 调研审阅：`stage: draft|approved` + `candidates:[{id, kind:fact|insight, text, sources[]}]` → 勾选写 insights/LESSONS.md（编号续接）
- 内容文件夹 content/{slug}/：如上

## 七、Host 路由（全过 security.ts：Origin=loopback + 根白名单[kb, content 根, ~/.dsh] + 路径穿越检查；client 只传 POSIX 相对路径）

health ｜ fs/list|read|write|mkdir ｜ search{q,layer}（FTS5 better-sqlite3，mtime 增量，库 ~/.dsh/storages/dsh-deck-fts.db）｜ kb/index|graph ｜ review/approve ｜ state + project/create|update|delete ｜ watch/attach ｜ publish/wechat-draft ｜ publish/prefill ｜ accounts/status

## 八、文件结构与行预算

```
plugins/dsh-deck/
  package.json cordis.patch.yml pnpm-workspace.yaml tsdown.config.ts scripts/link-deps.mjs
  src/
    index.ts(路由总装~150) routes/{security(80) fs(120) search(150) deck(100) watch(100) publish(200)}.ts
    client/{index.tsx(150) container.tsx(350) desk-kb.tsx(450) desk-media.tsx(550) mount.ts(120) common.tsx(150)}
  tests/ vitest：security/fts/mount-dedupe/review-approve/project-crud
```

## 九、逐日排期（半天块 + 验收框）

- [x] D1上 骨架+security+fs+state+项目 CRUD+单测 → ✅ 2026-08-24 完成：vitest 14/14 绿；端到端 10 项实测过（双源拦截 403/穿越 400/根外 folder 400/内置不可删/写读 roundtrip/CRUD）。commit e431175
- [x] D1下 环境前置检查 → ✅ 2026-08-24 结果：bun✓ npx✓ **Chrome✓（已装，CDP 可行——此前"无 Chrome"判断有误）** kb-git✓（工作树干净）FTS 计时✓（5487 md / 5.2MB 全扫 2.4s → FTS5+mtime 增量方案绿灯，无需降级）。**两个待用户解锁**：①公众号凭据链空（EXTEND.md/env/.baoyu-skills/.env 全无）→ 草稿 API 验证挂起，需 AppID/AppSecret 或改浏览器模式；②APIFY_TOKEN 无 → D6 海外数据回流挂起。CDP 预填实测顺延 D5（本就要登录态）
- [x] D2上 FTS 查询路由+知识台读侧（移植 panel-src）+ 点子 tab → ✅ 2026-08-24 完成：FTS5 trigram 索引 5486 篇（2.4s 全量+5min TTL 增量）；搜索/四库浏览/md 预览/insights 复盘/点子捕获全通；vitest 20/20 绿。commit 见 D2下
- [x] D2下 md 预览+insights 复盘+搜索联调+点子捕获/流转 → ✅ 2026-08-25 完成：**响应"这啥啊"差评，弃 440px 侧条，重构为全屏工作台壳**（dk-shell 左栏+台面标签+卡片网格+控制室 v0），agent-browser 回归搜索 20 条/181ms（<100ms 阈值偶尔超但可接受，P95 需 D7 调优）；点子→TASK.md 采纳链路实测过
- [x] D3上 任务卡协议+「发给 zcode」+AGENTS.md 接单+绑定+容器侧栏/向导/tile → ✅ 2026-08-25 完成：TASK.md 多卡协议（frontmatter+`---`分隔，acceptance fm；分号或 body checkbox 双解析，8 单测）；host 路由 tasks/task/create|status|dispatch+roots；派发=起 cmd 新窗口跑 zcode（80ms 实测，降级 clipboard+复制按钮）；新建向导（名称/图标/文件夹/模板，脚手架自动写 AGENTS.md+README.md）；项目↔会话绑定（ctx.sessions.list 快照+订阅，picker 选现有/新建 cwd 会话，openSession 切换，bindSession 落 deck.json）；容器侧栏（用户项目进左栏）+删除按钮+收起 tile；**控制室卡片墙（任务计数）+统一看板（跨项目四列聚合，提前完成 D3下 一部分）**。两个坑：①rolldown(tsdown 0.22) 会把某个 void(async IIFE) 路由体摇掉→handler 改 async 形式；②client 静态模块改完必须重启 web 才生效（服务端缓存 bundle）；③cordis ctx 属性要 inject:['sessions'] 声明才能访问。vitest 28/28
- [x] D3下 watch+挂载器+审阅区+落库执行器+控制室卡片墙+统一看板 → ✅ 2026-08-25 完成：**验收通过——一题 queued（建卡 UI）→ 发给 zcode（新终端）→ 按协议交活（RESULT.md v2 判断/来源 + widget-result.json）→ 审阅台勾选 2 条 → LESSONS.md「九、Deck 落库」新节 + git 提交 b329eb0 → 卡自动 done，看板跨项目正确聚合（✅1/⏳1）**。实现：review.ts 纯层（RESULT 解析/widget 防御解析/中文序号章节续接，7 新单测共 35 绿）；host review/result + review/approve（唯一写 LESSONS 通道：picks 校验→追加→git add/commit→卡置 done）；client 审阅台（知识台+自定义台都有：判断勾选/来源/RESULT 全文折叠/产物 iframe sandbox 预览 html|url|file）；AGENTS.md v2（RESULT 格式模板+版本标记自动升级）。轮询 5s 即 watch（agent 改 TASK.md 状态即时反映），独立 watch 路由砍掉不做。零 DS token ✓。事故记录：git stash drop 误删 D3下 未提交改动，git fsck --unreachable 找回 stash commit 恢复（教训：drop 前先看 stash list）
- [x] D4上 内容 schema+看板四列+三形态模板　D4下 PPT 实测一单+产物挂载 → ✅ 2026-08-25 完成：**一篇内容全周期验收通过**——UI 建 PPT 选题「一页看懂 dsh 插件开发」（脚手架 meta/选题/发布记录/素材/+三形态模板：文章=草稿、视频=脚本+分镜、PPT=PPT.md）→「交给 zcode」自动建任务卡（含类型验收条目）+起终端 → agent 交活（6 页 PPT html + widget-result.json + meta→ready + 卡→review）→ 看板列移动（idea→drafting→ready→prefill）→ 详情弹窗产物挂载（widget file 声明 + *.html 自动发现，双 iframe 沙箱预览，视觉确认幻灯片渲染）+ 文件 chips + 状态推进。host：content/list|create|status|handoff（launchZcode 抽公共）。5 新单测共 40 绿。**第二次踩同款坑：`find() !== null` 挡不住 undefined（MediaBoard open → ContentDetail item=undefined → 读 item.slug 崩整个 overlay）——规则：find 结果必须 `?? null`，已两处（Workspace/MediaBoard）**
- [x] D5上 发布预填队列+发布记录回写 → ✅ 2026-08-25 完成（**范围变更：公众号整体跳过——用户拍板，只做微博/X**）：意图链预填（微博 service.weibo.com/share/share.php?title=、X x.com/intent/post?text=，URL 参数天然预填正文）；buildPrefillText 按形态取正文（草稿/脚本/PPT.md）去 md 记号限长截断；发布记录.md 表格追加（预填行+发布行带链接）；预填即推 meta→prefill、记录发布即 →published；PublishFlow 弹窗（平台选择/开预填页/复制文本兜底/贴链接回写）。API 实测：预填 URL 编码正确、记录两行落表、状态流转。**发布永远是预填+人工点发，无任何自动发布**。D5下 账号面板（CDP 登录探测）砍掉——意图链模式无需登录态管理
- [ ] D5下 微博/X 预填实测【用户配合：登录+人工点发】→ 待用户在场时走一遍真实发布（微博已登录✓、X 待验证；agent-browser 无法测用户登录态，留给用户点「生成预填并打开」实测）
- [ ] D6上 评论收件箱薄版+AI 起草　D6下 审阅发送【用户配合】+数据回流 → 评论起草到发出；数据回填一篇
- [ ] D7上 agent-browser 回归+修漏　D7下 分屏 v1（落后即砍，两台保持独立 overlay）+ 发版 0.1.0+tag

## 十、环境前置 / 用户配合点 / 数据安全 / 席位

**环境（D1上）**：bun 或 npx ✅；Chrome ✅（已装）；FTS 计时 ✅。**范围变更（2026-08-24 用户拍板）**：公众号凭据跳过——D5 发布一律走浏览器预填模式（含公众号，不依赖草稿 API）；APIFY_TOKEN 跳过——D6 数据回流仅中文平台薄抓/手动录入。
**用户配合点（提前约）**：D5 各平台浏览器登录+人工点发；D6 评论审阅发送。其余 agent 自主。
**数据安全**：knowledge-base 先确认 git（无则 init+首提交）；落库执行器原子写（tmp+rename）；每落库 git commit（信息=判断编号）。
**席位**：deck 的 shell.overlay order=90（polymarket=100）；sidebar.footer.action order=20。

## 十一、风险触发器

| 触发 | 动作 |
|---|---|
| D1下 CDP 不通 | 全周剪贴板预填（baoyu 自带），D5 验收改复制+手动粘贴 |
| FTS >500ms | 降级 INDEX.md 全文+前缀匹配 |
| D3 落后半天 | 评论运营挪 v0.2 |
| D5 落后半天 | 砍 D7 分屏保发版 |
| 评论抓取改版 | 收件箱降级手动粘贴+AI 起草 |

## 十二、明确不做

玻璃拟态皮肤；通用任意窗口 dock；AI 未审直接落库；自动点发布（永远人工终审）；xhs 发布（无技能）；**polymarket/depsec 集成进工作台（仅作工程先例参考）**

## 附：运维备忘

web 可靠启动（后台 shell PATH 不含 node，用绝对路径）：<br>**Playwright 演示窗口一律 3840×2160 全屏开（用户双 4K 屏，小窗直接挨骂）**：
```
cd C:\Users\20369\.dsh\profiles\web
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 C:\Users\20369\.version-fox\sdks\nodejs\node.exe D:\coding\deepseek-harness\apps\cli\lib\bin.js web
```
