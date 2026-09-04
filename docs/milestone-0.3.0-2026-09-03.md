# H11 · 0.3.0 周末发布里程碑 · 计划

> 立项：2026-09-03（周四）｜ 目标：**周末发布 0.3.0「上下文所有权层」公开版** ｜ 状态：执行中
> 前置：H7 交接 / H8 镜像 / H9 治理已收官；测试报告 test-report-2026-09-03.md 已归档

## 0. 完成度基线（2026-09-03 评估）

| 轴 | 状态 | 缺口 |
|---|---|---|
| 会话 | 6 适配器 + 扫描/蒸馏/详情/导出 | 搜索仅关键字 FTS，无语义 |
| 历史 | 两层轨迹 + git 维度 | ✅ |
| 上下文 | 记忆管线全链路 + 治理自动化 + 双份存储 | 环境事实无新鲜度提醒 |
| 对接 | 6 agent + MCP 16 工具 + 自主召回实测 | ✅ |
| 发布 | 双包脚本/README/CHANGELOG/装机自检 | M4 材料 + publish |

## 1. 里程碑范围

### M-A · 会话语义检索 `（周四，旗舰项）`
- [ ] `session-index.ts`：sessions 表加 `vec BLOB` 列（惰性生成——搜索时对无向量会话嵌 入 title+首轮用户消息，≤1000 会话 JS 余弦足够）
- [ ] `searchSessions` 升级混合：FTS 关键字 + 向量语义 → RRF 融合（对齐记忆层 hybridSearch 模式）
- [ ] 增量：新蒸馏/导入的会话自动补向量
- [ ] GUI 会话页搜索框无缝切换（混合命中 = 关键字命中 + 语义命中分组展示）
- [ ] 单测：混合排序 / 惰性补向量 / 中文 query
- **验收**：搜"向量库选型"能命中讨论过 qdrant/milvus 的会话（关键字搜不到）

### M-B · 环境事实新鲜度 ✅ 2026-09-04 `（周五，小）`
- [x] recall 返回中，`fact` 类型且 `created_at` 距今 >90 天 → 追加"⚠ 该事实距今 N 天，引用前先验证"提示 ✅ 2026-09-04（引擎标注 stale/ageDays；CLI 行尾 ⚠；MCP 回执前置警示；dsh 插件 memory_recall 内联 ⚠；GUI 召回页高亮徽标）
- [x] 单测 ✅
- **验收**：命中旧环境事实时三端可见提示 ✅ 隔离库 200 天前 fact 实测带 ⚠

### M-C · 发布物料与动作 `（周五）`
- [ ] M4 收尾：market 元数据（名称/简介/图标）+ hippo-context npm 发布 dry-run
- [ ] 真实 publish（人执行）：dsh market 上架 + `npm publish --access public`
- [ ] 0.3.0 tag + GitHub release notes（引 test-report）
- **验收**：dsh market 可搜到 dsh-hippo；npm 可装 hippo-context

### M-D · 周末真实使用 `（周六日）`
- [ ] 冷神日常使用 = 活体 fidelity 测试；问题记入 H7 §8.1
- [ ] 收集反馈排下个迭代（候选：fidelity bench / 多机 / 生态对接）

## 2. 出界 → **H12 · 0.4 迭代（2026-09-04 立项，冷神：发布不急，先做后面要的功能）**

计划：docs/plan-0.4-2026-09-04.md（同目录）。三件套 + 测试，发布物料冻结不动。

- **M-02 精炼 few-shot 样例库**（先行）：172 条人工判决（收/弃+理由）入 `~/.hippo/refine-samples.jsonl`；refine prompt 动态注入真实 few-shot——压缩质量从"静态 prompt"变"随判决积累变好"
- **M-01 tier 老化归档**：sleep 新阶段——90 天前的 lesson/decision 群按项目+月卷成摘要记忆（LLM 压缩，失败降级拼接），原始条目 supersede 沉底可逆；上下文越积越大的长期答案
- **M-03 context_fold 工具**：会话内压缩即服务——agent 把已消费会话区间交给 hippo，蒸馏成记忆+指针返回（借力自有 transcript 优势，接 tier 老化）
- 判决特征挖掘报告（accept/discard 率 by source_rule/type）作为 M-02 附产

## 2.1 原候选记录（2026-09-03 提出"压缩方法学习"）

- **压缩自学习闭环**：①人工判决（收/弃+理由）特征挖掘回填候选排序；②会话↔摘要配对做 LLM 精炼 few-shot 样例库；③recall"真被用上"信号回传强化/衰减
- **tier 老化归档**：旧记忆随时间粗化（90 天 lesson 群卷成方向摘要，原始条目沉底可逆）——ACP tier-1/2/3 借鉴落地
- **会话内压缩即服务**：agent 会话过长时调 hippo 折叠已消费区间为记忆+指针（借力自有 transcript 优势）
- fidelity bench 完整落地（周末只做真实使用积累）
- 多机同步、记忆图谱、团队协同

## 2. 出界（0.3.0 内）

- ❌ fidelity bench 完整落地（周末只做真实使用积累）
- ❌ 多机同步、记忆图谱、团队协同

## 3. 风险

- 会话语义检索动 session-index（sessions.db schema 变更）——老库迁移要容错
- minimax 额度消耗：嵌入走本地 bge-m3 不花钱 ✅；LLM 精炼只在 distill 时

## 4. 变更日志

- 2026-09-03 立项：会话语义检索（M-A 旗舰）+ 新鲜度提示（M-B）+ 发布（M-C）+ 真实使用（M-D）。
