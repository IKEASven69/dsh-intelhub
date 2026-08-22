# dsh-hippo · 跨 agent 记忆桥插件 · 方案文档

> 起草:2026-08-21(基于 hippo-skills v0.1.0 实测代码 + dsh v0.1.0-rc.8 插件体系;2026-08-22 收入本仓库)
> 位置:`dsh-plugin/plugins/dsh-hippo/`
> 定位:项目清单 P2(快赢线,一周体量)

---

## 〇、形态策略(2026-08-21 定)

**dsh 插件是唯一主产品形态;hippo-skills 降级为引擎包,不追求先打磨成独立产品。**理由:①hippo-skills 形态尚不完整(作者自评);②生态处于抢位期,速度 > 完整;③用户实际使用的场景就是 dsh 内,独立 CLI 没有独立分发价值。

由此带来的调整:
- **集成方式从 spawn CLI 改为 npm 依赖导入**——插件直接 `import hippo-skills`(`openEngine()` 库入口),用户无需全局安装,无进程开销;未完成的部分(蒸馏质量/数据源覆盖/模型下载体验等)作为**插件内路线图**迭代,带"beta"标注发布,不阻塞 H5。
- 引擎不完整不等于体验残缺:H1 迁移输出**诚实的统计与质量标记**(哪些会话/项目覆盖了、置信度如何),面板标注"迁移引擎 beta,持续改进",把预期管理做在前面。

---

## 一、定位与范围

**一句话**:把你在 Claude Code / Codex / opencode 会话里积累的记忆搬进 dsh——dsh 一开局就认识你的项目和偏好。

| 做 | 不做 |
|---|---|
| 从本地其他 agent 会话历史**挖记忆**(hippo distill,已有能力) | ❌ 通用记忆系统(OpenViking 29515⭐ / hindsight 20215⭐ 的战场) |
| dsh 内 `memory_recall` 语义检索 + 注入 | ❌ 云同步 / 账号体系(坚持 local-first) |
| 一键迁移命令 `/memory import` | ❌ 重写嵌入/存储引擎(全部复用 hippo-skills) |
| (H4)dsh 会话回写记忆 → 双向 | ❌ 自动全量注入(只按任务检索 Top-K,防上下文污染) |

**市场依据**(调研清单 v2.1 核实):77 个记忆插件中"一键迁移"专用位为空(sage-mem 4⭐ 手工复制;engramory 155⭐ 是"共用"不是"迁移");rc.8 官方把 Claude Code/Codex 做成可安装 Profile Bundle——官方亲自打通生态,迁移叙事有背书。

---

## 二、现状盘点(全是现成的)

hippo-skills(npm 已发布,v0.1.0):

| 资产 | 形态 | 对插件的意义 |
|---|---|---|
| `openEngine()` | 库入口(main: dist/hippo/engine.js) | MemoryEngine:remember/recall/similar/update/forget |
| `hippo` CLI | bin | remember/recall/list/stats/**import/export/compile/distill/patterns/serve/doctor/ui/web** 十五命令 |
| `~/.hippo/memories.db` | SQLite+FTS5+vec_memories | 跨插件共享存储,L0 原文 blob 可回放审计 |
| `hippo compile` | → AGENTS.md / CLAUDE.md / .cursor/rules | **零插件路径**:dsh 原生读 AGENTS.md! |
| `hippo distill` | 从其他 agent 会话历史挖记忆 | 迁移的"挖矿"步骤 |
| `hippo patterns` | 跨会话挖重复工具工作流 → SKILL.md 草稿 | 预测卡(见四·二)的原料;对接 dsh skill 系统 |
| `server-http.ts` / `dashboard.ts` / `ui` / `web` | HTTP 引擎 + 仪表盘 | 常驻模式与面板素材 |
| `doctor` | 环境体检 | 首次运行引导 |

**关键事实**:hippo-skills 依赖 `better-sqlite3` + `sqlite-vec`(原生模块)。按 〇 的决策,插件**以 npm dependencies 声明引入**(tsdown external,不打进产物),原生二进制在插件安装时由 pnpm 装入;install 脚本被默认拦截的风险由 H0 doctor 兜底(见三)。

---

## 三、集成架构(三层,渐进)

```
L0(今天就能用,零开发):hippo compile → AGENTS.md → dsh 自动加载(引流技巧,保留)
L1(插件 MVP,发布形态):插件 npm 依赖 hippo-skills,直接 import openEngine()
    —— 首选 node:sqlite / better-sqlite3 由插件安装带入,无需用户全局装任何东西
L2(体验优化,引擎侧迭代):distill 质量提升、更多 agent 数据源、嵌入模型轻量化
```

- **L1 是发布形态**:插件 `dependencies` 里声明 hippo-skills,tsdown external 处理,dsh 插件安装(pnpm)时一并装入
- **嵌入模型**:首次 distill/recall 下载 bge-m3(插件 doctor 负责引导与进度展示);后续 L2 可换轻量模型降低首跑门槛
- ⚠️ **一个必须处理的坑(与 depsec 形成互文)**:pnpm 10 / npm v12 默认拦截依赖 install 脚本,`better-sqlite3` 的 prebuild 二进制正是靠 postinstall 下载的——被拦则回退 node-gyp 源码编译,Windows 用户大概率失败。对策:H0 doctor 检测原生模块是否可用,不可用时引导用户放行(`pnpm approve-builds` 或把 better-sqlite3/sqlite-vec 加入 `onlyBuiltDependencies`);README 直接写明;**装了 depsec 的用户可用它的"写回放行清单"一键完成**——两个插件互相导流

---

## 四、里程碑(每步有验收)

| # | 内容 | 验收 |
|---|---|---|
| **H0** | 插件骨架:`plugins/dsh-hippo/`(抄 depsec 的 package.json/cordis.patch.yml/tsdown 三件套,改名);dependencies 引入 hippo-skills;doctor 自检(原生模块可加载?嵌入模型就绪?失败给放行/下载指引) | dsh 加载插件,设置页出现"记忆桥"面板,自检结果与指引正确显示 |
| **H1** | `/memory import`(command):doctor → 对 Claude Code/Codex/opencode 会话目录跑 distill → stats 汇报("从 312 个会话提炼出 87 条记忆,覆盖 4 个项目") | 在有 Claude Code 使用史的机器上,一条命令完成迁移 |
| **H2** | `memory_recall`(tools.register):参数 query + 自动带当前 workspaceRoot 作 project 过滤;输出结构化(记忆+来源会话+时间);**`systemPrompt.section` 注入一段**:告知模型有此工具 + 当前项目 pinned 记忆 3 条以内 | dsh 会话中模型自主调用 recall 回答项目问题;注入段 <200 token |
| **H3** | 面板(设置页,抄 depsec 的 RPC 模式):搜索框 + 记忆列表(类型/强度/来源)+ forget/update + "编译 AGENTS.md"按钮(=hippo compile) | 面板检索与工具检索同源;一键 compile 后 AGENTS.md 更新 |
| **H4** | 回写(可选):会话结束钩子/命令把 dsh 会话中有价值的沉淀 `hippo remember`(默认关,显式开启) | 双向闭环:在 dsh 里学的项目事实,下次 Claude Code compile 也能用 |
| **H5** | 发布:README(迁移前后对比 GIF:同一个"我们项目用什么状态管理?"问题,无记忆 dsh 一问三不知 vs 迁移后直接答对)→ MIT → awesome-dsh-plugin 收录 → dsh-market | 收录通过,可一键安装 |
| **H6+** | **自我进化循环**(见四·二,v0.2 愿景) | 总结/调研/预测/自退役四步跑通一个完整周期 |

---

## 四·二、记忆的自我进化循环(v0.2 愿景,2026-08-21 增补)

> 记忆不是仓库,是活系统。四步循环把 hippo 从"存取引擎"升级为"会自我进化的记忆"——
> 市场对照:反思/巩固只有 dsh-mneme(22⭐)的 autoDream 沾边,"调研验证"与"预测"完全空白。

**核心概念(个人版定义,与任何在研项目无关)**:
1. **分级寿命**:闲聊/过程性内容按遗忘曲线衰减(强度 `s *= exp(-Δt/τ)`,τ 按类型取值,recall 命中视为复述重置——间隔重复路数);领域事实/决策/约束/需求类长期保留。
2. **退役而非删除**:记忆被新记忆覆盖时进入退役态(supersededBy + 更改原因),不再参与召回但保留在历史中——每条当前信念可溯源("agent 为什么信这个")。本质是"事件日志 + 当前投影",git 式审计。
3. **自我进化四步**(每日或每周定时,dsh 原生零件齐全):
   - **总结**(reflection):subagent 后台把近期记忆 + patterns 挖掘的行为模式合成高层洞察,洞察本身是带 `derivedFrom` 链的新记忆;
   - **调研**(verify):对"外部世界事实"类记忆(会随世界变化的内容)做 web 复核——仍成立→刷新时间戳;不成立→退役提案并附新证据链接。记忆的新鲜度与证据链同构于 depsec 的思路;
   - **预测**(predict):从 patterns + 近期记忆生成"下一步预判卡",下次会话开场预取注入——记忆从被动召回变主动预告;
   - **自退役**(retire):强度衰减到阈值/被矛盾/调研过期 → 退役候选队列(理由+证据),设置面板一键审批,不裸删。

**落地依赖**:ctx.schedule(定时)、subagent/jobs(后台总结)、ctx.web.fetch(调研,depsec 已验证)、设置面板(审批门)。全部现成,无需新引擎——是"hippo 引擎 + 一个调度循环 + 四个 prompt 化步骤"。

**与多 agent 的衔接**:见 `../dsh-team-memory/PLAN.md`(2026-08-22 v2 两层模型)——频道/消息适合短期协调;成员私有记忆直接用本引擎(per-agent scope),共享团队记忆由 team-memory 做晋升+总结;mailbox/任务事件蒸馏进同一套分级/退役模型。家族总览与形态判定见 `../../docs/memory-architecture.md`。

---

## 四·三、Wake 对照与 v0.1.x 补强(2026-08-22 增补)

> 参照系:[iAmCorey/Wake](https://github.com/iAmCorey/Wake)(macOS 原生会话聚合器,Rust+GPUI,11 个 agent 适配器,SQLite+FTS5 trigram)。定位一句话:**Wake 管翻旧账(索引/搜索/恢复会话原文),hippo 管记住教训(蒸馏/去重/召回/注入模型)**——互补不竞争。可借鉴三点:mtime 增量扫描、适配器覆盖面、FTS5 trigram 子串搜索。
>
> 进度快照(2026-08-22):H0–H4 已完成并实测——148 会话(claude/codex/opencode)→ 248 条记忆;memory_recall 工具+systemPrompt 注入+面板管理+编译 AGENTS.md+回写工具全部落地。以下补强项排在 H5 发布前。

### H1.5 增量导入(Wake scanner 启发)

**现状**:每次 import 全量重扫+重嵌入全部会话(148 个 ≈35s;去重机制保证质量无害,但重复计算纯浪费)。

**改法**:`~/.hippo/import-state.json` 记录 `{文件路径 → mtime+size}`;import 时跳过未变更文件,只蒸馏新增/变更会话;统计区分 新增/跳过。状态与记忆库解耦(forget 不回收状态;删状态文件即强制全量)。

| 验收 | 第二次运行只处理增量(<5s);面板统计如实显示"跳过 N 个未变更会话";删状态文件可强制全量 |
|---|---|

### H1.6 适配器扩充(对标 Wake 的 11 个)

本机探测(2026-08-22)分级:

| 优先级 | agent | 会话存储 | 形态 |
|---|---|---|---|
| **P0(本机有真数据)** | gemini | `~/.gemini/`(267MB,含 antigravity brain 子树) | JSON,需定位会话主体 |
| | antigravity | `~/AppData/Roaming/Antigravity/User/workspaceStorage/*/state.vscdb` | VSCode 系 SQLite(Wake 的 sqlite_ro 模式) |
| | trae | `~/AppData/Roaming/Trae/User/{globalStorage,workspaceStorage}` | 同上;**Wake 未支持,我们抢先** |
| | pi | `~/.pi/agent/`(4.2MB) | 需定位会话文件 |
| P1(生态常见,本机无数据) | cursor | `~/AppData/Roaming/Cursor/User/workspaceStorage/*/state.vscdb` | sqlite_ro |
| | copilot / kimi / kiro / grok | 各家目录(Wake 路径可抄) | 本机无数据,路径待验证 |

技术注记:
- VSCode 系(antigravity/trae/cursor/kiro/windsurf)聊天记录在 `state.vscdb` 的 JSON blob 里,键名各家不同——better-sqlite3 **readonly** 打开(引擎已依赖,零新增),逐家摸键;
- **发现(inventory)先于解析**:目录存在但适配器未写时,面板如实标"未适配"(诚实统计原则,防止"装了就有"的错觉);
- 每个适配器 = `import.ts` 一个 `parse<Agent>(file) → Turn[]` + AGENTS 表一行,模式已由 codex/opencode 两个先例验证。

| 验收 | 本机存在会话数据的 agent(gemini/antigravity/trae/pi)全部可发现并导入;inventory 面板显示各 agent 会话数与适配状态 |
|---|---|

### v0.2 backlog:FTS 子串搜索(trigram 启发)

zvec 的 matchString(BM25)对**中文分词与代码子串**(函数名、报错片段)的召回有边界;Wake 用 FTS5 trigram 一并解决两者。当前不急(zvec 向量×FTS 混合检索够用)。**触发条件**:用户反馈"明明有这条记忆却搜不到"且查询是子串型 → 引擎侧评估 trigram 前处理或 FTS5 双轨。不排期,挂 backlog。

---

## 五、关键挂载点(沿用 depsec 验证过的 Cordis API)

- `ctx.commands.register` → `/memory import`、`/memory compile`、`/memory doctor`
- `ctx.tools.register(defineTool)` → `memory_recall`(output schema json + render text)
- `ctx.systemPrompt.section(order 低,体积小)` → 工具存在性 + pinned 记忆(严格限量,防上下文膨胀)
- `TypertRemoteService` + `@Remote(...)` → 面板 RPC;**客户端可用 depsec 已验证的 fetch 直连 `/api` 桥**(免去构建期生成 typert 契约的依赖)
- shell 调用统一走 `ctx.shell.resolve/run`(同 depsec),不自己 spawn 进程

**depsec E2E 沉淀的两条工程规则(2026-08-22 增补,本插件直接沿用)**:
1. RPC 方法参数**不得带默认值/解构/rest**(网关 SRC 校验拒绝)——签名一律 `method(request: XType)`;
2. client bundle 必须以 `window.__ModuleLoader__.load({ id: 包名, factory })` 格式自注册——本地构建管线直接复用 depsec 的 `.build-tools/build.cjs`(SWC stage-3 装饰器 + esbuild + 注册包装)。

---

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 原生模块 install 脚本被 pnpm10/npm12 默认拦截 | H0 doctor 检测并引导放行;README 明示;depsec 的"写回放行清单"可一键处理(互相导流) |
| 引擎不完整(distill 质量/数据源覆盖) | 形态策略 〇:beta 标注 + 诚实统计,迭代在插件侧进行,不阻塞发布 |
| bge-m3 模型下载门槛(国内网络) | import 前 doctor 预检;文档给镜像/offline 说明;L2 换轻量模型 |
| 记忆注入污染上下文 | 只 Top-K(默认 5)+ 最小 token 预算;面板可 forget |
| dsh rc 后续 breaking(参考 depsec 教训) | peerDep 锁 rc.8;发布前 rc 上回归 |
| 与 OpenViking/hindsight 共存 | 只读自己的 ~/.hippo,互不干扰;README 写明共存说明 |

---

## 七、排期与发布动作

- **插入点**:depsec 发布流程的等待空档;H0-H3 全部可本机写码(测试 mock 引擎输出),构建用 `.build-tools` 管线
- 一周节奏:H0+H1(1 天,核心就是命令封装)→ H2(1-2 天)→ H3(2 天)→ H5 发布;H4 发布后视反馈
- 发布叙事:**"官方 rc.8 让你在 dsh 里装 Claude Code 子代理;这个插件让你把 Claude Code 里的记忆也带来。"** 附 hippo compile 的 AGENTS.md 零插件玩法作为引流小技巧
- 命名:`dsh-hippo`(短,延续河马品牌;描述里带 "memory bridge for migrating from Claude Code/Codex")

---

## 八、成功指标

- 迁移命令在真实使用 3 个月以上的 Claude Code 机器上,5 分钟内完成 import 且记忆数 >50
- dsh 新会话冷启动问答准确率明显变化(README GIF 素材)
- 两周内 dsh-market 安装量 > 同期新插件中位;issue 里出现"支持 XX agent 迁移"类需求(= 需求验证)
