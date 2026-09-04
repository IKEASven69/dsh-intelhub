# H12 · 0.4 压缩自学习 + tier 老化 + 会话内压缩 · 计划

> 立项：2026-09-04（冷神：真实发布不急，先做后面要的功能）｜ 状态：**执行中**
> 前置：0.3.0 物料冻结（发布动作另行人执行）；172 条人工判决种子已备份

## 0. 核心洞察

压缩质量目前"不学习"：LLM 精炼每次从零判、人工判决用完即弃、召回无使用信号。
H12 让压缩**随使用变好**：判决回填 → few-shot 样例库 → tier 老化 → 会话内压缩服务。

## 1. 里程碑

### M-02 · 精炼 few-shot 样例库 `（0.5 天，先行）`
- [ ] `refine-samples.jsonl` 格式：{text, verdict: accept|discard, reason, source}
- [ ] `refine.ts`：loadSamples()（~/.hippo/refine-samples.jsonl）+ buildFewShot()（收/弃混选 K=6，多样性去重）注入 SYSTEM prompt
- [ ] `hippo refine-learn --from-shelved-backup <file>`：172 条人工判决入库
- [ ] 单测：样例注入/空库降级/混选去重
- **验收**：精炼 prompt 含真实样例；判decisions 与人工历史一致率可观察

### M-01 · tier 老化归档 `（1 天）`
- [ ] sleep 新阶段 `tierAging`：fact/lesson/decision 距今 >90 天、未取代、按 项目+月 分组 ≥3 条 → 卷成摘要
- [ ] LLM 压缩（refinerBridge 通道），失败降级规则拼接（首句+条数）
- [ ] 摘要记忆 type=lesson、agent=sleep:tier、text 带 [归档] 前缀 + 原始条数
- [ ] 原始条目 markSuperseded(→摘要)——recall 降权但演化链可逆
- [ ] 阈值常量导出 + 单测（分组/降级/可逆）
- **验收**：真库 dry-run 报告归档分组；apply 后 recall 命中摘要且链可溯

### M-03 · context_fold 工具 `（0.5 天）`
- [ ] MCP `context_fold`：入参 {text（已消费会话区间）, project} → extractCandidates+LLM 精炼 → 入库
- [ ] 返回：摘要 + 记忆 ids + L0 指针（agent 后续可 recall 反查）
- [ ] dsh 插件同步注册
- **验收**：真实会话区间折叠后 recall 可召回

## 2. 出界
- ❌ 特征挖掘建模（M-02 附产报告即可）；❌ 多机；❌ fidelity bench 完整版

## 3. 变更日志
- 2026-09-04 立项（从 0.3.0 里程碑 §2 升格为独立迭代）。
