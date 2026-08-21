# dsh 记忆体系总览（需求定稿 + 角色澄清）

> 2026-08-22 整理。源自 dsh-hippo / dsh-team-memory 立项讨论、openhanako 对照、knowledge-base 衔接讨论。
> 本文是两个记忆插件的**上位视图**：谁干什么、边界在哪、常见混淆一次说清。
> 详细计划：`plugins/dsh-hippo/PLAN.md`（H0–H6）、`plugins/dsh-team-memory/PLAN.md`（T0–T5 + v2 修订）。

## 一、家族成员：谁是什么

| 成员 | 形态 | 一句话职责 | 状态 |
|---|---|---|---|
| **hippo-skills** | npm 引擎包 | 唯一的蒸馏/存储/recall 引擎：三档去重（0.93/0.8）、top-N=20 截断、工具失败=lesson 信号、strength 强化、compile→AGENTS.md | TS 版 v0.1.0 已发布（npm） |
| **dsh-hippo** | dsh 插件 | **个人记忆桥**：把 Claude Code/Codex/opencode 会话史蒸馏进 dsh；H4 起双向回写 | PLAN 定稿（P2 快赢线） |
| **dsh-team-memory** | dsh 插件 | **团队认知层**：agent-team 事件 → 成员私有记忆 + 共享团队记忆（两层模型） | PLAN v2（P5，未开工） |
| **dsh-depsec** | dsh 插件 | 依赖安全审计四合一（漏洞/投毒/密钥/SAST）；记忆体系的工程母机 + 互赖方 | E2E 完成 |
| **KB crystal-\*** | SKILL.md | knowledge-base 的复盘运营（提炼/回看/skill 化）；晋升链顶层 | 运行中 |

**同一引擎，两个入口**：dsh-hippo 管"**我**"（单人的跨 agent 记忆连续性）；dsh-team-memory 管"**他们**"（agent 团队的集体记忆）。

## 二、高频混淆澄清（Q&A）

**Q1｜dsh-hippo 是把其他 agent 的"插件"接入 dsh 吗？**
不是。rc.8 官方已可把 Claude Code/Codex 装成 Profile Bundle——agent 本体装得进来，但装过来是**失忆**的。dsh-hippo 搬的是**记忆**（会话史里蒸馏出的项目事实/偏好/教训），不是插件/技能。发布叙事："官方让你装子代理，本插件让记忆也带来。"

**Q2｜hippo 是 Python 还是 TS？**
Python 版（`D:\coding\hippo`）是原型参考；**主引擎是 TS 移植 hippo-skills**（npm v0.1.0，better-sqlite3 + sqlite-vec + zvec + transformers 本地嵌入），已与 Python 版同构对齐（三档阈值、top-N、失败信号、strength 模型全一致）。所有 dsh 插件直接 `import`，KB 的 skill 通过 CLI 调用。

**Q3｜openhanako 是依赖吗？**
不是，是公开参照（liliMozi/openhanako，6254★）。它验证了"每 agent 独立记忆 + Agent 即文件夹 + reply 才写记忆"——即 L1 私有层的可行性；它**没有**共享团队记忆，这正是 L2 的空白位。团队场景判词：生活流最优，工作流不足。

**Q4｜depsec 和记忆体系什么关系？**
三个交点：①**工程母机**——RPC 签名规则（参数不带默认值/解构/rest）、client bundle `__ModuleLoader__` 注册格式、`.build-tools` 构建管线，全部由 depsec E2E 沉淀，dsh-hippo/team-memory 直接沿用；②**硬互赖**——dsh-hippo 依赖的 better-sqlite3/sqlite-vec 原生模块的 install 脚本被 pnpm10/npm12 默认拦截，depsec 的"写回放行清单"一键放行（两个插件互相导流）；③**哲学同源**——PASS/WARN/BLOCK 证据分级 ↔ 记忆置信三档与退役证据链。

**Q5｜"蒸馏"和"总结"是一回事吗？**
不是。**蒸馏**＝引擎逐条提炼（事件驱动，记"知道了什么"）；**总结**＝跨事件归纳协作模式（周期任务，LLM 刚需，记"我们怎么协作"——分工模式/瓶颈这类信息不存在于任何单条事件里）。总结是预判卡的原料供给。

## 三、两层记忆模型（team-memory v2 核心）

```
L1 成员私有记忆（每个 agent 只蒸馏自己的 reply/任务经历）
   · 各写各的 → 授权边界天然干净、零写入竞争、保留角色专长
   · 复用 hippo 引擎，per-agent scope（project=agent id）
                │ 晋升判定（联合提炼：≥2 条私有记忆语义互为印证）
                ▼
L2 团队共享记忆（单一事实源）
   · 中心只做两件事：晋升 + 总结（跨成员协作模式）
   · 承载全员一致的事实/约束；新成员冷启动即得
```

- **晋升信号**："同一个坑被 ≥2 个成员独立踩到"＝最硬的团队级信号（判定标准同 KB 的联合提炼判定）
- **读侧注入**：成员私有 Top-K + 团队 pinned 约束（≤3 条，防上下文污染）
- **退役三级分流**（按"忘掉的错误成本"分级，不按表面类型）：

| 条目 | 处理 |
|---|---|
| 闲聊 / 已被取代 | 自动退役（derivedFrom 链保留，不打扰人） |
| 决策/约束到期（用户白名单除外） | 审批队列：面板批量，附最后访问/引用数/来源链 |
| 被矛盾推翻 / 调研过期 | 退役提案附证据 → 聚合进周期报告（防审批疲劳） |

- **衰减模型**：类型基线 τ × 用户白名单（决策/约束类永不衰减，只接受矛盾检测）× strength 访问强化（recall 命中 +1，log1p 加权）——白名单＝静态先验，strength＝动态后验，互补
- **存储**：append-only JSONL 事件账本为真相源（退役＝retire 事件带 supersededBy，fold 过滤当前视图——并发免锁、审计免费）；sqlite+vec 只做查询层；MD 频道投影＝可再生视图；L0 原始事件 90 天滚动窗口

## 四、形态判定：什么做成插件 / skill / 引擎

| 判定 | 标准 | 清单 |
|---|---|---|
| **dsh 插件** | 需要常驻运行/宿主 API（事件订阅、定时任务、面板、工具注册） | dsh-hippo、dsh-team-memory（depsec 已在） |
| **SKILL.md** | 按需触发、人做裁决、要跨 agent 跨机器通用 | KB 三件（升级 crystal 系列）：联合提炼检测、判断回看+引用强化、insights→AGENTS.md 编译 |
| **npm 引擎包** | 被插件 import + 被 skill 经 CLI 调用的共享能力 | hippo-skills |

## 五、晋升链全景与硬边界

```
agent 会话 / 团队事件
  → 蒸馏（hippo 引擎）→ 私有记忆            （自动，项目内）
  → 晋升（联合提炼）  → 团队记忆            （自动 + 审批门，项目内）
  → patterns / 联合提炼 → KB insights/、skills/  （人工把关，跨项目）
```

KB 的 `skills/` 是 SKILL.md 标准格式、任何 agent 可直接加载——它是"人类把关的跨项目方法论终库"，站在晋升链最顶层；反向通过 hippo compile→AGENTS.md 供血给各 agent。

**硬边界：记忆插件的进化循环只写自己的 `~/.hippo` 存储，永不直写 knowledge-base**——KB 的每次变更都走 skill + git commit（人看得见 diff）。这条边界保住"KB＝人类把关终库"的性质，插件也不需要 KB 仓库写权限。
