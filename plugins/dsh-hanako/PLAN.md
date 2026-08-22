# dsh-hanako · 生活流多 agent 社区插件 · 计划

> 立项:2026-08-22(用户提议:"dsh 没有 openhanako 那样带交互性质的多 agent 插件,要不加上?")
> 状态:**计划,未开工**。项目定位:记忆家族第三入口——hippo=个人记忆,team-memory=工作流团队,hanako=**生活流社区**(有性格的常驻 agent 居民 + 频道 + 主动发言)。
> 一句话:**一群有性格、有记忆的 agent 居民住在频道里,和用户互相聊天,reply 沉淀为记忆,人格随经历演化。**
> 上位视图:`../../docs/memory-architecture.md`

---

## 〇、差距分析(为什么这是真空白)

| 维度 | dsh agent-team(rc.8,工作流) | openhanako(生活流) | 本插件 |
|---|---|---|---|
| 成员 | spawn_teammate 时的 prompt(任务说明书) | **常驻人格**(persona 文件,持续存在) | ✓ 常驻居民 |
| 生命周期 | 任务完成即散 | **永居**(记忆延续,人格演化) | ✓ 永居 |
| 触发 | 用户驱动 | **随机点醒/定时主动发言** | ✓ 主动 |
| 场所 | 无(抽象协作) | **频道**(topic 房间,人类可读 MD 投影) | ✓ 频道 |
| 记忆 | 无(这正是 team-memory 补的) | reply 摘要进各自记忆 | ✓ hippo 引擎(我们更强:向量化/三档去重) |
| 人设演化 | 无 | 无(人格静态) | ✓ **人格随记忆演化**(独家:人格 = 初始 persona + 记忆 compile) |

dsh 平台已有的挂载点(全部验证过):`ctx.llm`(LlmRuntime,直接调模型)、`ctx.webServer`(面板/chat API)、`ctx.tools`(用户侧工具)、subagent 体系(continuable session)、hippo-skills 引擎(记忆)。**openhanako 用 ~1400 行跑通全循环;我们比它多一个生产级记忆引擎,少写的正是它最难的部分。**

## 一、架构

```
① 居民(Agent Resident)
   ~/.dsh/hanako/residents/<name>/
   ├── persona.md        初始人格(用户写或模型起草)
   ├── memory-scope.md   人格演化视图(persona + 近期记忆 compile,可再生)
   └── state.json        活跃频道/最后发言/情绪基线
② 频道(Channel)
   ~/.dsh/hanako/channels/<id>/
   ├── channel.md        元数据(主题/成员/创建)
   ├── history.jsonl     append-only 消息账本(真相源)
   └── bookmark.json     每居民游标(读到哪了——token 经济:没读的不进上下文)
③ 行为循环
   被动:用户/他居民发言 → 唤醒相关居民 → ctx.llm 生成 reply(带 persona+记忆+频道近况)
   主动:调度器随机点醒(频率=人格参数) → 居民自己决定说不说、说什么
   记忆:reply 落 hippo 引擎(scope=hanako:<name>,复用三档去重)
   演化:居民人格视图 = persona.md + compile(高强记忆) ——"经历塑造性格"
④ 面板(hippo GUI /hanako 页)
   频道列表/聊天流/居民卡(人格/记忆数/活跃度)/创建居民与频道
```

**与 openhanako 的刻意差异**(借其验证、补其短板):
- 记忆:它文件锁仅进程内、无去重 → 我们用 zvec 引擎(向量检索/三档去重/衰减);
- 人格:它静态 → 我们**人格演化**(persona + 记忆 compile,记忆塑造性格);
- 投影:同它(频道 MD 可再生投影,"文件即真相"给人类看);
- 不做:token 经济复杂计价(保留 bookmark 游标防上下文爆炸即可)。

## 二、里程碑

| # | 内容 | 验收 |
|---|---|---|
| **K0** | 骨架+数据模型:居民/频道/账本/游标 CRUD + webServer 路由 + GUI /hanako 空页 | 面板能创建居民(带 persona)与频道 |
| **K1** | 被动对话循环:用户在频道发言 → 唤醒 1..n 居民 → ctx.llm 生成 reply(persona+记忆+游标内近况注入)→ 账本+MD 投影 | 与两个居民真实对话数轮,reply 有人格差异、记忆被引用 |
| **K2** | 记忆接入:reply → hippo 引擎(scope=hanako:<name>);居民 recall 工具(检索自己记忆决定怎么回) | 居民引用三天前对话内容(记忆生效) |
| **K3** | 主动行为:调度点醒(随机+频率参数) → 居民自主决定发言/沉默;跨频道串门 | 无用户输入时频道出现居民自发的合理发言 |
| **K4** | 人格演化:persona + compile(高强记忆) 生成演化视图,模型每次对话用演化视图 | 居民经历事件后,语气/偏好可观测变化 |
| **K5** | 发布(随 H5 一起 npm) | 与 hippo 家族同批 |

## 三、关键技术决策

1. **LLM 调用走 `ctx.llm`(LlmRuntime)**:平台统一出口,复用用户配的 provider/代理/计费——不自带模型客户端。生成用 hand-built call(非 loop-built,不污染会话日志)。
2. **居民不是 continuable subagent**:生活流居民的"连续性"由记忆承载(每次对话 = persona+记忆重新组装),不需要 session 续命——比 agent-team 的 continuable 模型轻,且崩溃/重启零成本。
3. **账本 append-only**(与 team-memory 同哲学):history.jsonl 为真相源,MD 投影可再生,bookmark 游标控上下文预算。
4. **主动性的安全阀**:点醒频率人格化参数(话痨/寡言);发言前自检(与频道近况重复度>阈值则沉默);面板一键全静音。
5. **人格演化的边界**:persona.md 永不自动改写(用户主权);演化只发生在 memory-scope.md(可再生视图)——"性格变了"可随时溯源到记忆,也能一键回到出厂人格。

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| 主动发言失控(刷屏/跑题) | 频率参数+自检沉默+全静音开关;K3 验收含"合理沉默" |
| LLM 成本(居民常驻对话) | 游标控上下文;点醒间隔下限;面板显示每居民 token 用量 |
| 人格演化漂移成怪人 | 演化只动视图不动 persona;compile 只取高强记忆;一键回出厂 |
| 与 agent-team 概念混淆 | README 明确分工:team=干活(任务 DAG),hanako=生活(频道闲聊/陪伴/讨论);记忆层互通(同一引擎) |

## 五、与既有项目的关系

- **hippo-skills 引擎**:记忆/去重/compile 全复用——hanako 是第三个消费者(GUI/distill/import 之外);
- **dsh-hippo**:个人记忆桥——hanako 居民的记忆与用户个人记忆同库不同 scope,未来可互相检索(居民知道主人的偏好=真正的"了解你");
- **dsh-team-memory**:工作流 vs 生活流,同一引擎两种组织形态;hanako 频道里的讨论也可被蒸馏成团队记忆(远期);
- **openhanako**:公开参照(非依赖),借其"reply 才写记忆/频道 MD/随机点醒"三个已验证设计。
