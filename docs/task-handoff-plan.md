# 任务状态加厚 + WorkBuddy 适配 · 计划（H7 线）

> 立项：2026-08-31 ｜ 审核：2026-08-31（第一轮，修正 4 处）｜ 状态：**待冷神确认后开工**
> 归属：dsh-plugin/docs/（与 memory-architecture.md 同级）
> 追踪机制见 §8——本文件是 H7 线唯一事实源，每次动工先读 §4 勾选状态，收工写 §8 日志。

---

## 0. 架构审视（跳出现有设计看拓展性，2026-08-31）

### 0.1 全景：三条管线已经并存，不是一条

读全代码后发现 H7 之前漏掉的事实：**"多源→蒸馏"不是假设，是已发生的架构现实**。仓库里有两条成型管线：

| 管线 | 源 | IR | 存储 | 生命周期管理 |
|---|---|---|---|---|
| 会话蒸馏 | SessionAdapter ×5 | Turn[] | L0 sources + L1 zvec | distill 去重/加权 |
| 团队蒸馏 | team/adapter 事件 | team 事件自有格式 | team/ledger | **triage → promotion → retirement**（最成熟） |
| 任务状态（H7 对象） | TodoWrite | TaskRecord | tasks.json（旁挂） | 无（快照覆盖） |

**结论：H7 的 M1-M4 不需要发明新架构，而是把第三条管线补齐到前两条的成熟度**——M2 的轨迹归档 ≈ team 线的 retirement 简化版，M3 的回流 ≈ distillTeamEvents 的模式复刻。

### 0.2 关键架构判断（面向未来扩展）

1. **源分两族，不过度统一**。会话型源（claude/codex/workbuddy…）走 SessionAdapter → Turn[]，事件型源（team、任务+git）各自 IR + 旁挂存储。**现在不为两族造统一事件总线**——两族语义不同（轮次流 vs 状态变更），强行统一是过度设计；等第三种事件型源出现再考虑抽公共层。
2. **Turn IR 不动**。Turn 字段（role/text/cwd/ts/toolName/toolFailed/model）是 5 个适配器 + patterns 的公共依赖；M1 的 git 维度挂 TaskRecord 而非 Turn，避免跨适配器连锁改动。WorkBuddy 适配器证明 Turn IR 够用（其格式可完整映射）。
3. **Candidate 是"事件→知识"的通用车票**。M3 回流必须组装成 `distill.ts` 的 Candidate 类型走既有管线，**不得为任务单开一条入 zvec 的路**——未来任何新源（PR、CI、部署记录）想沉淀知识，都走 Candidate，这是唯一入口。
4. **存储三层哲学保持**：L0 原始（审计）/ L1 知识（zvec）/ 操作状态（旁挂 JSON，轻量）。操作状态层未来会有更多成员（git 快照、session-index 已是先例），一律旁挂、不进 zvec。
5. **出口层并列不绑死**。M2 的"昨天卡在哪"查询做在 store 层（扩展 `tasksForProject` 一族），CLI / dashboard / compile 各自消费，不绑死在 compile→AGENTS.md 一个出口上。
6. **已知边界记录在案，H7 不解决**：zvec 单进程独占写锁（多 CLI 并发显式报错，可接受）；多机同步未涉及（本地单机前提不变则不堵路）。

### 0.3 拓展性自查表

| 未来可能的新需求 | 现架构是否容纳 | 靠什么容纳 |
|---|---|---|
| 新会话型 agent（WorkBuddy、未来 CLI） | ✅ | SessionAdapter 一文件一实现 |
| 新事件型源（PR / CI / 部署） | ✅ | 旁挂 JSON + TaskRecord 式 schema + Candidate 回流 |
| 新出口（面板增强、其他 MCP 消费者） | ✅ | 出口并列，store 层查询为公共底座 |
| 更聪明蒸馏（LLM refiner） | ✅ | **已落地**（2026-09-01：llmRefine 全链路接线，见 §2 新增行） |
| 多机/多进程并发 | ⚠️ 边界 | 单进程锁已显式报错；多机需另立项 |

### 0.4 架构图快照

全景图存于 [hippo-architecture-2026-08-31.svg](./hippo-architecture-2026-08-31.svg)（同目录）。**快照语义**：图带日期，代表当日架构状态；架构演进时重画新日期文件并保留旧图，在 §8.1 记一行——图本身也是变更追踪的一部分。

## 1. 定位与目标

**一句话**：让 dsh-hippo 的任务状态从"单次快照"加厚为"带 git 维度、可回溯轨迹、完成时回流记忆的完整管线"；同时新增 WorkBuddy 适配器，把当前主力工作环境的会话纳入记忆桥。

**背景判断**（已与冷神对齐；2026-09-01 按两轮质询修订，详见 §5.2.2）：
- **定位升级：hippo = 个人工作上下文的所有权层，agent 是租客（来了取、干活时还、走了不带走）。** H7 不是"handoff 工具"，是这个所有权层的取件/归还机制。
- 外部文章（豆包工作随感）核心是"沉淀"——长期使用沉淀下来的上下文才是护城河，且上下文的定义是**做事留下的痕迹（一手）**，不是人对事的转述（二手）。hippo 的 distill / patterns / 时间加权在做沉淀，方向已被验证；但数据源优先级须修正：行为痕迹（git/任务）一等公民，会话蒸馏降为解释层。
- 冷神的真实痛点是"传递"——Claude 里聊完的要手动搬给 Codex。传递的解法是**寄存**（归还到仓库 + 从仓库取件），不是点对点搬运。hippo 已有雏形（task-context.ts → compile.ts → AGENTS.md），缺的是**厚度**：git 维度、历史轨迹、完成回流。
- 竞争边界：传递赛道已有 memento（git 快照实体化）、ai-memory（15+ agent）、官方插件收编。**在沉淀上加深，不在传递上追赶。**
- **硬约束**：handoff 产物禁止写入 AGENTS.md（消费即弃：收件箱 pending → 取件注入当轮 → 归档）；AGENTS.md 只留薄指针 + 当前活跃任务，防上下文所有权错位回 agent 载体（AGENTS.md 常驻注入，追加式写入会 token 膨胀 + 注意力稀释）。

## 2. 代码现状依据（2026-08-31 实测，均已核实）

| 能力 | 状态 | 证据（已核实） |
|---|---|---|
| 记忆蒸馏 + 去重强化 | ✅ | `plugins/dsh-hippo/src/hippo/distill.ts`（规则 + 噪音闸门 + **LLM 精炼**，0.93/0.8 三档去重。路径已随 hippo-skills→dsh-hippo 单包合并迁移，hippo-skills 仓库 2026-08-29 归档） |
| 混合召回（向量+BM25 RRF） | ✅ | `plugins/dsh-hippo/src/hippo/zvec-store.ts` hybridSearch（存储栈已切 zvec：proxima + rocksdb FTS） |
| 间隔重复（命中即强化） | ✅ | recall 内调 `store.touch()` |
| 工作流挖掘 → SKILL.md | ✅ | `plugins/dsh-hippo/src/patterns/miner.ts` 四维打分 |
| **LLM 蒸馏精炼（2026-09-01 新增）** | ✅ | `refine.ts` llmRefine：规则粗筛→LLM 判决/改写，经 `distill(refiner=)` 接入 auto-distill + import 全链路；LLM 失败降级纯规则；审计 `~/.hippo/llm-refine.log` |
| **dsh-llm 统一桥（2026-09-01 新增）** | ✅ | `dsh-llm.ts`：ctx.llm.prepareCall→stream，模型跟随 agent-default-model（当前 minimax-cn/MiniMax-M3 Token Plan）；含思考模型 think 块剥离 |
| **噪音闸门（2026-09-01 新增）** | ✅ | distill.ts NOISE_PATTERNS：过程自语/标题/疑问/清单碎片在规则层即拦 |
| 任务状态采集 → AGENTS.md | ⚠️ 半通 | `task-context.ts`（TodoWrite → TaskRecord）→ `compile.ts:154`（Active Tasks 写入） |
| git 维度 | ❌ | 全仓库零 git 调用 |
| 历史轨迹 | ❌ | `mergeTasks()`：同项目旧任务**整体替换**（注释明写"TodoWrite 是全量快照"） |
| 完成回流记忆 | ❌ | tasks.json 不进 zvec 为**有意设计**（文件头注释："任务是操作状态不是知识"），非疏漏 |
| agent 适配器 | 5 个 | `src/agents/{claude,codex,opencode,pi,zcode}.ts`，接口 `types.ts`（SessionAdapter/SessionRef → makeTurn Turn[]） |
| WorkBuddy 适配器 | ❌ 无 | 已实测可行，规格见 §5 |
| 状态更新入口 | ✅ | `updateTaskStatus()`（MCP task_update 调用）——M3 回流的现成钩子点 |
| 第二条蒸馏管线（team） | ✅ 已存在 | `team/adapter.ts` + `team/distill.ts` + ledger/triage/promotion/retirement——H7 前期盘点遗漏，§0 已补 |

## 3. 范围

**做**：
- M1 git 维度采集
- M2 任务轨迹（快照策略 → 轨迹策略）
- M3 任务完成回流 distill
- M4 WorkBuddy 会话适配器

**不做**（明确出界）：
- ❌ restore / verify（git 工作树实体化）——memento 的地盘，冲突处理是深坑
- ~~摘要 LLM 化~~ **已于 2026-09-01 完成**（llmRefine 全链路，见 §2）——本条从出界清单移入已完成
- ❌ 信任链传递——全赛道无人解，非本阶段该碰
- ❌ **不推翻"任务状态不进 zvec"的设计**——M3 回流的是"完成任务时学到的 decision/lesson"，不是任务本身；任务操作状态仍留在 tasks.json

## 4. 里程碑

### M0 · 真物冲刺 ✅ 2026-09-01 `（0.5 天内完成）`
- [x] 用真实会话跑通最小蒸馏：`scripts/m0-handoff.py`（零 LLM，规则抽取 + git 对账）✅ 2026-09-01
- [x] 产出真实快照：`dsh-plugin/.handoff/HANDOFF.md`（来源 sess_94519137「hippo记忆」，4104 条消息）✅ 2026-09-01
- [x] 接手测试：冷神在 zcode（cwd=dsh-plugin）说「读取 .handoff/HANDOFF.md 接手，复述任务状态和下一步，不要重新探索仓库」⏳ 待冷神执行
- **M0 暴露的真实缺陷（比任何设计推演值钱）**：
  1. verbatim 近重复未去重（同句三种微差变体各保留一条）——精确匹配去重不够，M1 须加归一化
  2. `git diff --stat HEAD` 不含未跟踪文件，对账层把 untracked 判成"无改动"——对账规则要补 untracked 维度
  3. Next 无法可靠自动推导（人工播种可用，快照已标注来源）——印证 §5.2.1「LLM 叙事层」存在的必要性；**该层已于 2026-09-01 落地**（llmRefine），M5 摘要可直接复用
  4. 会话标题「hippo记忆」信息量薄，任务真实含义在 todo+commit 里——多源对账（而非单源标题）是对的核心

### M1 · git 维度采集 `（约 0.5 天）`
- [ ] `task-context.ts`：`TaskRecord` **新增** `changed?: string[]` 与 `branch?: string` 字段（现为 project/text/status/priority/updatedAt/sessionId）
- [ ] 采集时执行 `git status --short`、`git diff --stat`、`git rev-parse --abbrev-ref HEAD`，填入新字段
- [ ] 非 git 目录静默降级（字段留空，不报错）
- [ ] 单测：临时 git 仓库夹具验证三条命令解析
- **验收**：真实会话采集后，tasks.json 中可见 changed 文件列表与分支名

### M2 · 任务轨迹 `（约 0.5 天）`
- [ ] **设计决策变更**（原策略是文档化的有意设计，此处推翻需记录理由）：`mergeTasks()` 从"同项目整体替换"改为"当前活跃 + 历史归档"两层——活跃层仍走全量快照（保持 TodoWrite 语义），历史层按 sessionId 追加归档
- [ ] 理由：冷神需要能回答"昨天卡在哪"——纯快照语义天然丢历史
- [ ] 归档模式参照 team 线的 retirement 简化版（completed 任务按 sessionId 归档，含完成时刻与当时 git 状态）
- [ ] 查询做在 **store 层**（扩展 `tasksForProject` 一族，如 `taskHistory(project, sessionId?)`），CLI/dashboard/compile 各自消费——不绑死 compile（§0.2 判断 5）
- [ ] `compile.ts:154` 适配：AGENTS.md 只展示活跃层，且**默认走 index 模式**（§7.1.1：常驻预算 ≤100 token，全量投影 opt-in）
- [ ] 容错：老格式 tasks.json 读入自动迁移
- [ ] **硬约束测试（2026-09-01 补，与 §5.2.2 交互）**：autoRecompile 闭环（记忆变更→自动重编 AGENTS.md）已上线——须有测试保证收件箱 pending 项**永不**进 compile 投影（M3 回流的 decision/lesson 进 AGENTS.md 属知识沉淀、合规；快照/handoff 产物违规）
- **验收**：能查询历史会话的任务状态（CLI 或接口均可）

### M3 · 完成回流 distill `（约 0.5–1 天）`
- [ ] 钩子点：`updateTaskStatus()` 置 completed 时，组装 distill 候选——`任务内容 + 卡点(Blocked) + 解法 + 当时 changed 文件`
- [ ] **必须组装为 `distill.ts` 的 Candidate 类型走既有管线**（§0.2 判断 3：Candidate 是事件→知识的唯一车票），模式参照 `team/distill.ts`（distillTeamEvents）的复刻
- [ ] 候选入 zvec 后带溯源（来源 sessionId + 时间戳，复用 L0 可回溯）
- [ ] **边界**：任务状态本身不进 zvec（维持 §3 出界声明）
- **验收**：完成一个任务后 `hippo recall` 可召回该条，且带当时上下文
- **这是"传递→沉淀"的关键一环**：每次交接自动喂记忆库，记忆里的决策从此带上下文

### M4 · WorkBuddy 适配器 `（约 1 天）`
- [ ] 新建 `src/agents/workbuddy.ts`，参照 `zcode.ts` 实现 SessionAdapter
- [ ] 数据源与格式规格见 §5
- [ ] 注册 `src/agents/index.ts`，`agents.test.ts` 补测试（格式映射用真实样本截取做夹具）
- **验收**：对 D:\coding 的真实 WorkBuddy 会话跑 distill / patterns，产出合理 Turn 序列

### M5 · 交付通道——快照怎么"进入"目标 agent（2026-08-31 新增）

核心设计决策：**拉模式（pull），不是推模式（push）**。不做"把 zcode 对话直接塞进 WorkBuddy 输入框"——原始对话搬运既撑爆上下文又绕过蒸馏，且 UI 注入脆弱。正确形状： hippo 把双端（zcode 适配器 + WorkBuddy 适配器）蒸馏进共享存储，目标 agent **在需要时自己拉**——推蒸馏快照 + 按需拉原始片段（L0 溯源引用支持 `hippo recall` 反查原文）。

三条通道，按优先级：

| 通道 | 机制 | 适用 | 状态 |
|---|---|---|---|
| **A. MCP 工具**（首选） | 在 `~/.workbuddy/mcp.json` 注册 dsh-hippo MCP server（stdio），WorkBuddy 会话内 agent 直接调 `hippo_handoff_load` / `hippo recall` | WorkBuddy（已是标准 MCP 宿主，chatcut 同法接入） | 待实现 |
| **B. Skill 触发**（跨 agent 统一入口） | 项目级 skill（WorkBuddy: `D:\coding\.workbuddy\skills\handoff\SKILL.md`；Claude Code: `.claude/skills/` 同内容），指令：会话开始或用户说"接手/继续"时 → 调通道 A 或跑 `hippo handoff --load` → 复述 Task/Changed/Blocked/Next → 确认后继续 | 一份 SKILL.md 通吃所有支持 skill 的 agent，交互时刻收敛为一句"接手" | 待实现 |
| **C. 文件兜底**（零插件） | `hippo compile` 除 AGENTS.md 外落一份快照文件（如 `.workbuddy/memory/HANDOFF.md`），skill/agent 直接读文件 | 目标 agent 无 MCP 无 skill 机制时的最坏情况 | 待实现 |

要点：
- 通道 A 需用户在连接器管理页对新 MCP server 点"信任"（WorkBuddy 机制，一次性动作，写进 README）。
- 通道 B 的 skill 不是自动执行的——它把"接手"这个动作变成一句触发词 + 标准流程，替代现在的"口述他干了什么"。
- "直接发送到会话框"明确**不做**：无可靠 UI 注入路径，且拉模式已覆盖同一需求（效果等价：新会话开场就有完整上下文）。
- 原始对话片段（"zcode 里某段讨论"）不进快照正文，快照只留 L0 引用，WorkBuddy 侧按需 `hippo recall` 反查——推蒸馏、拉原文。

- [ ] M5a：MCP 交付（`handoff_load` 工具 + mcp.json 注册说明 + 信任步骤文档）
- [ ] M5b：`handoff` skill 文件（WorkBuddy 项目级 + Claude Code 各一份，同内容）
- [ ] M5c：文件兜底输出（compile 扩展）
- **验收**：端到端——zcode 干活收工 → 新开 WorkBuddy 会话说"接手"→ 不口述任何背景，agent 复述任务状态并继续；再抽验一次 `hippo recall` 反查原始片段


### M5 修订 · 推选式交互（2026-08-31 深夜，冷神提出"点一个会话发送到 WorkBuddy"）

对上表通道的修订——推拉不是二选一，是分工：**推=准备（人筛选+机器蒸馏+投递），拉=消费（agent 回合内取件）**。

交互设计：
1. zcode 会话历史中点选某会话 → `hippo handoff push --session <id> --to workbuddy`（dsh 面板按钮或 CLI）
2. hippo 调 zcode 适配器蒸馏该会话 + TodoWrite/git → 快照标记 pending（收件箱语义）
3. WorkBuddy 侧取件两形态：新会话开局 skill 自动查收件箱 → **零动作接上**；已开会话 → 一句"接手 [hippo:<id>]"经 MCP 取件

关键修正与约束：
- 人点选 = 人工筛选，补纯自动采集的噪声短板；两模式并存（后台自动采集 + 显式推选交接）
- **物理约束记录在案**：agent 只在自身回合处理输入，无外部注入 API，不做输入框 UI 注入——"接收到"的体验发生在新会话开局自动取件，非正在打字的输入框
- zcode 侧按钮依赖 dsh 面板扩展面（H3 面板已有按钮先例）；CLI 为兜底
- 验收新增：zcode 点选推送 → 新开 WorkBuddy 会话零口述接上该会话任务状态

- [ ] M5a：`handoff push` CLI + 收件箱 pending 标记（store 层）；取件工具按 §7.1.1 分层粒度设计（详情 ≤500 token + L0 ref，不倒原文）
- [ ] M5b：MCP 交付（`handoff_load`/`inbox` 工具 + mcp.json 注册说明）
- [ ] M5c：`handoff` skill 文件（开局自动查收件箱，WorkBuddy/Claude Code 各一份）
- [ ] M5d：文件兜底输出（compile 扩展）
- [ ] M5e：zcode/dsh 面板"推送"按钮（依赖面板扩展面，可后置）

## 5. WorkBuddy 会话格式规格（2026-08-31 实测）

路径：`~/.workbuddy/projects/<workspace-slug>/<uuid>.jsonl`（已实测 `d-coding/` 存在；一文件 = 一会话，单 sessionId）

| 记录 type | role | 处理 |
|---|---|---|
| `message` | user | → 用户轮 |
| `message` | assistant | → 助手轮（content 内 `input_text` 等块需解析） |
| `reasoning` | — | → 可选并入助手轮（对齐 zcode 的 reasoning 映射） |
| `function_call` / `function_call_result` | — | → 工具调用（patterns 挖掘必需） |
| `file-history-snapshot` / `ai-title` / `resend-fork-notice` | — | 忽略 |

顶层字段：`type, role, content, id, sessionId, timestamp, cwd, providerData`——有 cwd 有 sessionId，适配器只需一层格式映射。项目归属直接取 cwd。


### 5.1 与既有 handoff skill（get-shit-done）的差异（2026-08-31 实测后补充）

冷神指出：handoff skill 早已存在（GSD 已装 60+ skill，且实际用过——`ai-replay-ops/.continue-here.md` 等）。实测 GSD 机制后确认差异如下，H7 的存在理由必须站在这些差异上：

GSD 交接机制实测：`/gsd:pause-work` 手动触发 → agent 收集状态（含向用户澄清提问）→ 写**本项目** `.continue-here.md`（已完成/已解决/剩余工作，叙事型）→ git commit WIP；`/gsd:resume-work` 读 STATE.md + `.continue-here.md` 恢复。`gsd-extract-learnings` 从 GSD 自有工件（PLAN/SUMMARY/VERIFICATION）手动抽 LEARNINGS.md。

| 维度 | GSD handoff | hippo H7 |
|---|---|---|
| 触发 | 手动调 pause-work + 回答澄清问题（依赖优雅退出） | 零动作：transcript + TodoWrite + git **事后**采集，会话崩了也能采 |
| 存储粒度 | 每项目一个文件，覆盖式 | 跨项目共享存储，轨迹追加（M2） |
| 跨 agent | 仅 Claude Code（skill 归 CC）；其他 agent 无标准拉取入口 | 任一适配器写入（M4），任一 agent 经 MCP/skill/文件拉取（M5） |
| 传递→沉淀 | 割裂：交接文件用完即弃；learnings 手动、只认 GSD 自有工件 | M3 完成自动回流 distill；patterns 挖工作流 |
| 记忆治理 | 无（文件只增不减，无去重/权重/衰减） | 既有 distill 管线（去重/强化/衰减） |
| 叙事质量 | **GSD 更好**——含用户澄清、验证结果、覆盖率数字 | 自动采集语义较浅，接受此代价 |

诚实结论：**单 agent × 单项目场景 GSD 已够 80%**。H7 的存在理由恰好是冷神的真实形态——多 agent（zcode/Claude/WorkBuddy/Codex）× 多项目 × 会话经常非正常终止：per-project 文件不流动、手动 pause 不会发生、事后采集才成立。若某天只单 agent 干活，直接用 GSD，别硬上 H7。


### 5.2 蒸馏方法与精准度设计（2026-08-31 深夜，回应冷神三问：方法/效果/精准度）

核心立场：**handoff 的精准度不来自文笔，来自证据链交叉验证。** GSD 式文档交接是 agent 的一次性主观叙事（说了什么就是什么，无验证无置信度）；H7 的快照是**多源证据的结构化对账**。

**蒸馏方法 = 三步管线（零 LLM 可跑）：**

1. **结构化抽取**（不摘要）：从各源抽取结构化信号——会话 transcript（声明的决策/卡点）+ TodoWrite（任务真实状态）+ git status/diff（实际改了什么）+ 测试/验证输出（实际成没成）。只抽取，不生成散文。
2. **跨源交叉验证（关键差异点）**：同一事实多源对账——agent 声称"修了 X"，但 git diff 里没有 X 的文件 → 降权并打 `unverified` 标记；声称与 diff 一致 → 高置信；测试输出佐证 → `verified`。每个字段带 confidence + provenance（来源引用）。这正是 Unblocked 指出的"裸 MCP 是三个标签页，没人 join"——join+reconcile 就是蒸馏本身。
3. **分层落盘**（对齐既有 L0/L1 架构）：
   - 快照 L1：Task/Changed/Blocked/Next + 置信度 + 出处
   - 证据 L0：原文可回溯（recall 反查）
   - 沉淀 L2：完成后经 Candidate 回流 zvec（M3），进既有去重/强化/衰减治理

**源扩展（todo/bug/测试等，不止会话）**：按 §0.2 判断 #2 的"事件型源旁挂"模式接入，架构早留了位置：
- 任务：task-context.ts（已有）
- bug 清单：代码内 TODO/FIXME/HACK 扫描 + 测试失败输出 → 旁挂 schema
- 每种新源 = 一份旁挂 schema + 一个抽取器，经 Candidate 回流知识层，不动 Turn IR

**效果怎么测（验收即基准）**：借 memento 保真度基准思路，建 handoff fidelity bench：
- 复述保真：下一 agent 仅凭快照复述任务状态，与证据对账的遗漏数/幻觉数（声称无证据支撑）
- 接手成功率：下一 agent 首轮动作（改对文件/跑对命令）无需回读原文的比例
- 噪声率：快照中与任务无关条目占比（推选式人工筛选作对照）
用真实跨 agent 任务链跑（ai-replay-ops / dsh-plugin 均可），不造合成数据。

**诚实边界**：零 LLM 抽取的语义上限低于 GSD 的叙事质量（含用户澄清、验证细节）——精准度靠交叉验证补，叙事缺口留给 `extract_candidates(refiner=...)` 钩子后续可选接 LLM 提质，不破坏零依赖卖点。



#### 5.2.1 修订：LLM 调用的取舍（2026-08-31 深夜，冷神质询"为啥不能做 LLM 调用？规则真能压缩成功？"）

**质询成立，原立场修正。** "零 LLM"是 hippo 老管线的既有约束（零依赖、无 key、隐私），不该原样继承给 H7。诚实拆解：

**规则擅长的（确定性工作，LLM 反而不该碰）**：
- 结构化抽取：git status/diff、TodoWrite 状态、文件清单——本来就是结构化数据，正则/解析是**无损**的
- 跨源对账："声称修了 X 但 diff 里没有 X"这类验证，**必须**规则做——确定性、可审计、LLM 会幻觉恰恰是它不能当裁判的原因
- verbatim 字段：逐字保留，无压缩发生，谈不上质量

**规则做不了的（叙事压缩，质询命中）**：
- 判断"哪段讨论重要到值得进快照"、隐式决策识别（模型默默选了 Redis 没宣布）、长探索过程凝练成一句话——这些规则只能靠关键词运气，**压缩质量天花板明显**（distill.py 的正则管线实测只抽得到显式声明的四类候选）

**修订：三层混合管线**
1. **规则层（必须）**：结构抽取 + 跨源对账 + 置信度打标——快照的事实骨架，零 LLM 也成立
2. **LLM 叙事层（可选增强，默认开）**：输入=规则层的结构化骨架 + 待压会话区间，输出=摘要/隐式决策/优先级排序；产出走**与 agent 声明同等待遇**——进对账管线打置信度，不因为"是 LLM 说的"就免检
3. **verbatim 层（必须）**：用户明确说出的决策/约束/验收标准逐字直存

**LLM 从哪来（三选，运行时决定）**：
- A. **API 直调**：**已实现（2026-09-01）**——llmRefine 经 dsh-llm 桥走 dsh 配置的模型（当前 MiniMax-M3），无 LLM 自动降级纯规则；M5 的 handoff push 摘要直接复用 `llmCompleteWithFallback`，无需再选
- B. **会话内 agent 生成**：接手/收工 skill 指示**当前 agent 自己**写摘要再入快照——零额外 key（GSD 叙事质量好的真实原因），缺点=依赖优雅退出
- C. **收件方 agent 拉取时按需合成**：快照存骨架，下一 agent 取件时用自己上下文当场合成——缺点=每次接手重算

推荐：**A 为默认 + B 为离线兜底**。成本估算：一次 handoff push ≈ 1 次调用 / 2-5K tokens，量大可忽略。

**关键不变量**：LLM 参与压缩，**不参与验证**。裁判始终是规则层——这是快照精准度的来源，也是 §5.2 交叉验证立场的保留部分。

### 5.2.2 定位修订：所有权层 + 行为痕迹一等公民（2026-09-01，冷神两轮质询后定稿）

**质询链**：①"往 AGENTS.md 加会爆吗？"→ ②"你是不是还是没弄明白文章提到的问题"。

**病根重判**：AGENTS.md 膨胀不是存储工程问题，是**所有权错位**——上下文被绑在 agent 身上，而 agent 是无常的（会话结束、工具更换、模型升级），上下文必须活得比任何 agent 长。对应文章题眼（入口迁移 + 上下文护城河）：护城河的前提是上下文有独立的 home。

**定位一句话**：
> **hippo 不是"handoff 工具"，是个人工作上下文的所有权层。agent 是租客：来了取、干活时还、走了不带走。**

推论（与既有设计的因果对齐）：
- 跨 agent 交接的本质不是"A 点对点发给 B"，而是 **A 归还到仓库、B 从仓库取件**——M5 推拉模式的本质是寄存不是传递
- AGENTS.md 不再是上下文的家：只留薄指针 + 当前活跃任务；**handoff 产物禁止写入 AGENTS.md（消费即弃：收件箱 pending → 取件注入当轮 → 归档），此为硬约束**
- hippo 既有蒸馏/分层/retirement 恰是所有权层的运维机制，文章说的"沉淀"即此

**上下文定义修正（比定位更关键）**：文章周报例的锋利处——没上下文时"你把做过的事一条条告诉它，本质上你自己先写了一遍"；有上下文时它读的是会议纪要/群聊/文档/看板，即**做事过程留下的痕迹，不是人对事的转述**。会话文本是二手的（会遗漏、美化、遗忘），行为是一手的。

据此重判 M0 快照的内容价值：

| 快照内容 | 性质 | 原对待 | 修正后 |
|---|---|---|---|
| git branch/HEAD/status/log | 一手行为痕迹 | 附属信息 | **一等公民** |
| todo 状态 | 一手任务事实 | 附属信息 | **一等公民** |
| 会话蒸馏 | 二手转述 | 主体 | 降为"为什么这么做"的解释层 |

**落地落点**：
1. M0 脚本快照排版：Task/Changed/Blocked 骨架（行为痕迹）前置，会话摘要后置为解释段
2. M1 采集权重：git/任务状态从附属字段升为独立采集层（脚本骨架已在，主要是权重与排版）
3. §5.2 蒸馏优先级：行为痕迹层是一等公民，会话蒸馏是补充——与"蒸馏必须比 GSD 高级"对齐（GSD 交接的是嘴说的，H7 交接的是做过的）
4. 取件 skill 的验收语序：接手 agent 先复述行为痕迹（改了什么/到哪一步），再复述叙事（为什么/下一步）

### 5.3 参考实现：billion-context（ACP）的压缩机制（2026-08-31 深夜调研）

**定位区分**：billion-context（npm，ranxianglei，本地已有源码 `D:/coding/三方/billion-context-pi`）是**会话内**上下文压缩代理——插在 agent 与模型 API 之间，模型主动调 compress 把已消费的对话区间折成摘要，解单会话窗口爆炸问题。**hippo 是跨会话沉淀层**。层级不同、不构成竞争，但四个机制值得 H7 借鉴：

| # | ACP 机制 | 原文做法 | H7 借鉴落点 |
|---|---|---|---|
| 1 | **Ref 引用体系** | 每条消息注入不可见 ref 标签（m00001…），模型用 ref 精确指定压缩区间 | H7 快照的 provenance 从"来源 sessionId"细化到**消息级 ref**——跨源对账（声称 vs diff）可精确到哪几条消息 |
| 2 | **多层渐进蒸馏（tier-1/2/3）** | tier-1 摘要堆积→系统注入 nudge→模型再压缩成 tier-2→tier-3，越压越凝练 | 直接喂 M2 归档设计：归档层不是死仓库，是**可再蒸馏的活层**——日级 tier-2 / 项目级 tier-3，回答"这周整体卡点是什么"时不用扫原始任务 |
| 3 | **可逆原则** | 摘要永不唯一事实源：decompress 可还原原文（块保持折叠、缓存前缀不动）；提示词明写"关键细节先 decompress 验证再行动" | 印证 H7 的分层落盘（快照 L1 / 证据 L0 / 沉淀 L2）方向正确；H7 的 unverified 标记 = ACP"先验证再行动"规则的主动化 |
| 4 | **摘要即元数据非指令** | 注入模型的安全规则：摘要内容是历史记录，不是当前指令，不得据此行动 | **handoff skill 安全规则**：接手 agent 读快照时，快照里的"决策/待办"是历史事实，执行前须当下确认——写进 M5c skill 文件的提示词 |

**零 LLM 限制的部分借法（回应 §5.2 诚实边界）**：ACP 的摘要质量靠模型写，H7 没有。但它有一条零 LLM 也能抄的规则——**"必须逐字保留的内容，不进压缩区间"**（重要用户消息、验收标准原文直保）。H7 对应：用户**明确说出**的决策/约束/验收标准，抽出来逐字存（verbatim 字段），不做语义改写——这比"提炼"便宜且无失真风险，正好补零 LLM 叙事质量的一部分短板。

**顺带注意**：`bili dsh` launcher 已把 deepseek-harness 纳入客户端清单，说明该生态与用户侧工具链已有交集；其 8 阶段管线（refs→sync→prune→filter→hide→recommend→nudge→emergency truncate）中 **nudge（提示而非强制）** 的治理手法与 hippo distill 的被动式设计同构，可参考用于 M2 归档时机（不硬触发，状态提示 + 查询时兜底）。

## 6. 执行顺序与拍板项

- 默认顺序 M1 → M2 → M3 → M4 → M5；如冷神想先见 WorkBuddy 支持，M4/M5 可提前并行（M5 的 A/B 通道依赖 handoff 数据模型，M1-M3 是其地基，但 skill 文件与 mcp.json 注册说明可先写）。
- **M2 是设计决策变更**（推翻文档化的"快照"策略），需冷神明确点头。
- tasks.json 老格式迁移策略：直接切 + 容错读（装机量小）。

## 7. 面向对象、使用方法与使用效果（2026-08-31 调研结论）

调研基础：ai-memory（install-hooks/run 的被动采集 UX）、memento（inject/restore/verify 的接手 UX）、社区手工交接模式（HANDOFF.md / AGENTS.md / threadId 接力）+ hippo 自身既有形态（MCP recall、compile、dashboard、auto-distill）。

### 7.0 面向对象

| 对象 | 定义 | 依据 |
|---|---|---|
| **主：冷神本人** | 单机、多 agent 并行（WorkBuddy / Claude Code / Codex / zcode），真实痛点 = 跨 agent 手动交接 | 痛点是他每天在付的成本，dogfooding 是第一验收方式 |
| **次：同形态开发者**（未来外扩前提） | 本地优先、2+ 个 coding agent 并用、接受 CLI/MCP 形态 | ai-memory 与 memento 已验证这类用户存在且接受此形态 |
| **明确不是** | 团队/企业（team/ 线与外部 Glean 类产品的地盘）；不装 CLI 的纯云 IDE 用户 | 出界声明，防再次套错框架 |

### 7.1 使用方法（落地后的用户视角）

| 环节 | 用户动作 | 支撑 |
|---|---|---|
| 采集 | **零动作** | auto-distill 扫描会话时自动抓 TodoWrite + git（M1） |
| 接手 | 下一个 agent 正常开局，不重讲 | compile→AGENTS.md 自动带活跃任务（已有；M2 保证历史不丢） |
| 查过去 | CLI 查询（"昨天卡在哪"） | store 层 taskHistory（M2） |
| 沉淀 | **零动作**（任务完成时） | updateTaskStatus(completed) 自动组装 Candidate 入记忆（M3） |
| 召回 | 任意 agent 里 MCP recall | 已有；M3 后记忆带上下文 |
| WorkBuddy | 一次性注册进 inventory | M4 适配器 |

**UX 设计原则**（对齐竞品已验证的形态）：采集与沉淀必须零动作（ai-memory 的 hooks 被动采集模式）；接手成本必须为零（memento 的 inject 模式）；交互只允许发生在"查询 / 验收"时刻。

#### 7.1.1 双约束定稿：无感 × 上下文预算（2026-09-01，冷神定调"要的效果是无感 + 最大限度减少上下文"）

两条约束合起来推翻一个隐含假设——交接的默认形态**不是"注入一份快照文档"**（GSD 式 1-3K token 全文常驻），而是**薄索引常驻 + 按需取件**（progressive disclosure）：

**上下文预算三层（agent 侧）：**

| 层 | 常驻成本预算 | 内容 | 进入时机 |
|---|---|---|---|
| L-索引（常驻） | **≤100 token** | 活跃任务名×3 + 卡点一行 + "记忆库/收件箱可用"指针 | 开局自动，无需触发词 |
| L-取件（回合） | 按需 0-500 token | `handoff_load`/`memory_recall` 返回的蒸馏详情 + L0 ref | agent 判断需要时一次工具调用 |
| L-溯源（原文） | 0（不常驻） | L0 原文片段 | 极少数情况反查 |

**无感四环节闭环**：①采集无感（auto-distill 事后扫描，已有）→ ②注入无感（开局薄索引自动就位，不用说"接手"）→ ③消费即弃（注入当轮用完归档，不残留）→ ④沉淀无感（completed 自动回流，M3）。

**对既有设计的两处修正推论**：
1. **compile 默认产 index 模式**（`renderIndexMd` 已实现，indexMode 已有）——全量 AGENTS.md 降为显式 opt-in；handoff 相关内容**永不**进常驻投影（与 §5.2.2 硬约束同源，M2 测试项覆盖）
2. **MCP 工具粒度按"拉一层"设计**：`handoff_load` 返回蒸馏详情（几百 token）而非原始会话，响应内带 L0 ref 供按需再拉——不一次倒完

**验收量化**：接手会话开局常驻注入 ≤100 token；agent 首轮动作正确率不因薄索引下降（fidelity bench 照跑）；用户全程无感知词（无触发词、无确认对话）。

效果图两张（快照语义，同 §0.4 惯例）：
- 设计原理图（本节四面板：开局注入示例 / 预算三层栈 / 无感四环节 / 常驻成本对比）：[h7-handoff-ux-2026-09-01.svg](./h7-handoff-ux-2026-09-01.svg)
- **功能效果图**（一次完整交接的四个画面：①工作台推送⇪ ②WorkBuddy 开局无感注入 ③干活中按需取件 ④完成自动沉淀闭环）：[h7-feature-mockup-2026-09-01.svg](./h7-feature-mockup-2026-09-01.svg)

### 7.2 使用效果（前后对比）

| 维度 | 现状（前） | H7 后 |
|---|---|---|
| 跨 agent 交接 | 手动复制粘贴 / 口述重讲 | 开局自动接上活跃任务 |
| 记忆质量 | "选了 Redis"这类干巴巴结论 | 带当时 changed 文件与卡点上下文 |
| 可追溯性 | 只有最新一次快照 | 能回答"昨天卡在哪" |
| 沉淀自动化 | 完成任务学到的教训随会话丢失 | 自动进记忆库，recall 可召回 |
| agent 覆盖 | 5 个 | 6 个（+WorkBuddy 主力环境） |

量化验收不另设标准，即 §4 各里程碑的验收条目；端到端验证用冷神真实跨 agent 任务链（WorkBuddy → Claude Code → Codex），不造合成数据。

## 8. 文档追踪机制

1. **本文件**：任务完成即勾 `[x]` 并行尾标 `✅ 日期`；范围变更改 §3 并在 §8.1 记一行。
2. **§8.1 变更日志**：每次收工追加一条（日期 + 做了什么 + 下一步）。
3. **每日记忆同步**：`D:/coding/.workbuddy/memory/YYYY-MM-DD.md` 记一笔，保持跨会话连续。
4. **开工仪式**：接手先读 §4 勾选状态与 §6 拍板项，不凭记忆开工。

### 8.1 变更日志
- 2026-09-01 功能效果图落盘：docs/h7-feature-mockup-2026-09-01.svg（一次完整交接四画面：推送⇪/开局无感注入/按需取件/完成沉淀闭环），§7.1.1 挂引用。
- 2026-09-01 效果图落盘：docs/h7-handoff-ux-2026-09-01.svg（§7.1.1 四面板可视化——开局 85 token 薄索引实样、三层预算栈、无感四环节闭环、口述/GSD/H7 常驻成本对比条），§7.1.1 挂引用。
- 2026-09-01 **§7.1.1 双约束定稿（冷神："要的效果是无感 + 最大限度减少上下文"）**：交接默认形态从"注入快照文档"改为"薄索引常驻（≤100 token）+ 按需取件（0-500 token/次）+ 溯源不常驻"三层预算；无感四环节闭环（采集/注入/消费即弃/沉淀）；两处设计修正——compile 默认 index 模式（renderIndexMd 已有）、MCP 工具按"拉一层"粒度设计；验收量化（开局常驻 ≤100 token + 无触发词 + fidelity bench 不降）。M2/M5 勾选项已挂钩。
- 2026-09-01 **同步修订（H7 立项当日另一线完成的工作入档）**：①LLM 叙事层（§5.2.1 方案 A）已实现——llmRefine 规则粗筛→LLM 判决/改写接入 auto-distill+import，dsh-llm 桥跟随 agent-default-model（当日接通 minimax Token Plan/MiniMax-M3），失败降级纯规则；②代码基线合并——hippo-skills 仓库归档，全部引擎代码迁至 `plugins/dsh-hippo/`，§2 现状表路径与阈值（0.92/0.75→0.93/0.8）已校正；③噪音闸门上线（过程自语/标题/疑问/清单碎片规则层拦截，存量清理 643→511）；④M2 补硬约束测试项——autoRecompile 与"handoff 产物禁写 AGENTS.md"的交互须有测试兜底；⑤M0 缺陷 #3（Next 推导）标注已被叙事层落地解除。对 H7 的净影响：M5 摘要零新增依赖、M3 回流候选质量前置提升、面板按钮（M5e）宿主（/dsh-hippo/app 工作台）就绪。
- 2026-09-01 上午 §5.2.2 定位修订（冷神两轮质询："AGENTS.md 加会爆吗"→"还是没弄明白文章的问题"）：①病根重判——AGENTS.md 膨胀是所有权错位非工程问题，定位升级为"hippo=个人工作上下文所有权层，agent 是租客"，交接本质=寄存（归还+取件）非点对点传递；②上下文定义修正——文章说上下文是做事痕迹（一手），会话是转述（二手），M0 快照价值重判：git/todo 升一等公民、会话蒸馏降解释层；③硬约束落定：handoff 产物禁写 AGENTS.md，消费即弃。§1 背景判断同步改写。
- 2026-09-01 M0 真物冲刺完成：scripts/m0-handoff.py（zcode sqlite 四表 + git 对账，零 LLM）→ .handoff/HANDOFF.md 真实快照（sess_94519137）。暴露 4 缺陷：verbatim 近重复、diff 不含 untracked、Next 需人工播种（印证 LLM 叙事层必要性）、单源标题薄（印证多源对账）。接手测试待冷神在 zcode 执行。
- 2026-08-31 深夜 §5.2.1 修订（冷神质询"为啥不能 LLM/规则真能压缩？"）：立场修正——零 LLM 不该继承给 H7。拆解：规则擅长结构抽取+跨源对账+verbatim（LLM 幻觉恰使它不能当裁判）；规则做不了叙事压缩（关键词运气，天花板明显）。改三层混合：规则层(必须)+LLM 叙事层(可选默认开,产出按 agent 声明同待遇进对账)+verbatim 层(必须)。LLM 来源三选：A=refiner 钩子 API 直调(默认,无 key 降级纯规则) B=会话内 agent 自己写(离线兜底) C=收件方按需合成(不推荐)。关键不变量：LLM 参与压缩不参与验证。
- 2026-08-31 深夜新增 §5.3：冷神指路 billion-context（ACP）。本地源码实读（三方/billion-context-pi，compress-tool/state/system-prompt）：定位=会话内压缩代理，与 hippo 跨会话沉淀不竞争。借鉴四条：ref 消息级引用（快照 provenance 细化）、tier-1/2/3 渐进蒸馏（M2 归档可再蒸馏）、可逆原则（印证 L0/L1/L2 分层）、摘要即元数据非指令（handoff skill 安全规则）；另抄零 LLM 可用的 verbatim 规则（用户明确决策逐字保留不改写），补零 LLM 叙事短板。
- 2026-08-31 深夜新增 §5.2 蒸馏方法与精准度设计：回应冷神三问。定调"精准度来自证据链交叉验证而非文笔"——三步管线（结构化抽取→跨源对账打置信度（声称 vs git diff vs 测试输出，unverified 降权）→分层落盘快照L1/证据L0/沉淀L2）；源扩展按事件型旁挂模式（TODO/FIXME 扫描、测试失败输出→bug 清单）；验收=handoff fidelity bench（复述保真/接手成功率/噪声率，真实任务链）；诚实边界=零 LLM 叙事上限低于 GSD，留 refiner 钩子。
- 2026-08-31 深夜 M5 修订：冷神提出推选式交互（zcode 会话历史点选→发送→WorkBuddy 接收）。定调"推准备、拉消费"：点击=人工筛选+蒸馏+投收件箱；WorkBuddy 新会话开局 skill 自动取件（零动作）或已开会话一句"接手"取件。物理约束记录：无外部注入 API，不做输入框注入。任务拆为 M5a-e（push CLI+收件箱/MCP/skill/文件兜底/面板按钮）。
- 2026-08-31 冷神纠偏：handoff skill 早已存在（GSD，本地装 60+，实际用过 .continue-here.md）。实测 GSD pause/resume-work + extract-learnings 机制后补 §5.1 差异表：GSD=手动触发/单项目文件/仅 CC/交接与沉淀割裂，但叙事质量更好；H7=零动作事后采集/跨 agent/自动回流。诚实结论：单 agent 单项目 GSD 够 80%，H7 只在多 agent × 多项目 × 非正常终止形态下成立。
- 2026-08-31 新增 M5 交付通道：冷神问"zcode 对话怎么直接进 WorkBuddy 会话/上下文、能否做成 skill"。定调拉模式（推蒸馏快照 + 按需拉 L0 原文），三通道 A=MCP 工具（~/.workbuddy/mcp.json 注册，需连接器页信任）、B=handoff skill（跨 agent 统一触发入口）、C=文件兜底（compile 扩展）；明确不做 UI 输入框注入。
- 2026-08-31 架构图落盘 + 使用调研：新增 docs/hippo-architecture-2026-08-31.svg（快照语义，演进时重画保留旧图，§0.4）；新增 §7（面向对象=冷神本人/同形态开发者，UX 原则=采集沉淀零动作接手零成本，前后对比表+端到端真实验证）；追踪机制顺延为 §8，引用同步修正。
- 2026-08-31 立项：完成代码现状盘点 + WorkBuddy 格式实测。
- 2026-08-31 第一轮审核修正 4 处：① compile.ts 行号 150→154；② "旁挂孤岛"改为"有意设计"，M3 明确只回流 decision/lesson 不回流任务状态；③ M1 注明 changed/branch 为**新增**字段（原 TaskRecord 无此字段）；④ 文档从 plugin 根移入 `docs/`，并注明 M2 属设计决策变更需拍板。
- 2026-08-31 架构审视（冷神要求跳出现有设计看拓展性）：新增 §0。核心发现——team 线已是第二条"事件→知识"管线（此前盘点遗漏），H7 实质是把任务线补齐到同等成熟度而非发明新架构。六条架构判断落定：源分两族不过度统一、Turn IR 不动、Candidate 是回流唯一车票、存储三层哲学保持、查询做在 store 层不绑 compile、已知边界（单进程锁/多机）记录在案不解决。M2/M3 按此修订（归档参照 retirement 模式、回流参照 distillTeamEvents 模式）。
