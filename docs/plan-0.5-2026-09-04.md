# H13 · 0.5 反馈闭环与质量度量 · 计划

> 立项：2026-09-04 ｜ 主题：让压缩自学习真正转起来——0.4 铺了 few-shot 地基，0.5 接上使用信号和客观标尺
> 前置：0.3.0/0.4 已合入 main（周末与 0.5 一起打包发布）

## 0. 为什么是反馈闭环

0.4 完成后，压缩质量的输入有了 few-shot 样例库（172 判决），但两个回路仍断着：
1. **使用信号**：recall 命中的记忆"真被 agent 用上了"没有回传——强化/衰减只靠天数和点击
2. **客观标尺**：交接/召回质量靠体感，fidelity bench（H7 §5.2 定的三指标）没落地

0.5 = 把这两个回路接上。之后判决挖掘（M-02 附产）才有真数据可挖。

## 1. 里程碑

### M-1 · 使用信号回传 `（周四）`
- [ ] 引擎 `feedback(id, useful)`：useful=true → touch 强化（strength+0.2）；false → 衰减（-0.2，下限 0.5）
- [ ] 追加 `~/.hippo/memory-feedback.jsonl` 日志（id/useful/query/时间）——判决挖掘的数据源
- [ ] MCP 工具 `memory_feedback`（agent 引用完一条记忆后回传是否用上）
- [ ] dsh 插件 memory_recall 回执尾部提示 agent："引用某条后可用 memory_feedback 回传"（低频提醒，首次会话才提示）
- [ ] 单测：强化/衰减/下限/日志
- **验收**：MCP 调用 feedback 后 strength 可见变化，日志落盘

### M-2 · fidelity bench v1 `（周五）`
- [ ] `hippo fidelity --handoff <id>`：接手流程自动化——读快照 → 复述 → 与证据对账（声称 vs git diff vs 记忆库）
- [ ] 三指标输出：复述保真（遗漏/幻觉计数）、噪声率（快照中无关条目占比）、接手成功率（人工标注项）
- [ ] 报告落盘 `~/.hippo/fidelity-reports/`，连续交接可对比趋势
- **验收**：对已有 HANDOFF.md 跑一次出真实报告
- **诚实边界**：幻觉判定用规则对账（LLM 判决不参与验证——§5.2 不变量）

### M-3 · 判决特征挖掘 `（周五，附产）`
- [ ] `hippo refine-stats`：从 refine-samples + shelved 备份出报告——收/弃率 by type/source_rule/来源 agent/文本特征
- [ ] 结论回填：refine.ts 权重/模式表修正（如有明确规律）
- **验收**：报告出真实分布；至少一条可执行修正

### M-4 · 发布 `（周末）`
- [ ] 0.5.0 版本号 + CHANGELOG + 与 0.3.0/0.4 合并发布
- [ ] market 元数据过目（人执行上架）

## 2. 出界

- ❌ 嵌入模型微调/训练；❌ 多机；❌ 会话内压缩代理（billion-context 地盘）

## 3. 变更日志
- 2026-09-04 立项。
