# dsh-deck · 工作台插件 · 定稿计划（7 天冲刺 0.1.0）

> 立项：2026-08-24。**本文件是唯一权威版本**（对话中的历史版本作废）。
> 两内置台面（知识调研 / 自媒体）+ 可新建工作台的容器层 + zcode 引擎（零 DS token）+ 发布预填人工终审。
> 参考 dsh-worktable（MIT，只学思路不抄码）。执行：任意 agent 按本计划 + 必读清单开工。

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
- [ ] D3上 任务卡协议+「发给 zcode」+AGENTS.md 接单+绑定+容器侧栏/向导/tile
- [ ] D3下 watch+挂载器+审阅区+落库执行器+控制室卡片墙+统一看板 → 一题 queued→zcode→勾选落库零 DS token；看板正确聚合多项目
- [ ] D4上 内容 schema+看板四列+三形态模板　D4下 PPT 实测一单+产物挂载 → 一篇内容全周期
- [ ] D5上 公众号草稿队列+发布记录回写　D5下 微博/X 预填实测【用户配合：登录+人工点发】+账号面板 → 三平台预填一单
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

web 可靠启动（后台 shell PATH 不含 node，用绝对路径）：
```
cd C:\Users\20369\.dsh\profiles\web
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 C:\Users\20369\.version-fox\sdks\nodejs\node.exe D:\coding\deepseek-harness\apps\cli\lib\bin.js web
```
