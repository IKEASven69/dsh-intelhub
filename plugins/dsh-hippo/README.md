# 🦛 dsh-hippo · 记忆桥

**把 Claude Code / Codex / opencode / zcode / pi / WorkBuddy 会话里积累的记忆蒸馏进 dsh——开局即认识你的项目与偏好。**

本地优先 · 零 API key · 零遥测。引擎已内置（zvec 向量索引 + bge-m3 本地嵌入），装完即用。

## 两分钟上手

1. **安装**（dsh 内）：`dsh plugin --profile web add dsh-hippo`
   - pnpm 拦截原生模块构建脚本时，在插件目录执行 `pnpm approve-builds`（勾选 better-sqlite3 / @zvec/zvec）
2. **自检**：dsh 设置 → 记忆桥 → 环境自检全绿
3. **一键迁移**：点「开始迁移」——扫描本机全部 agent 会话，蒸馏出结构化记忆（决策/教训/偏好/事实）
4. **开局即认识你**：任何 dsh 会话里 agent 自动携带活跃任务薄索引（≤100 token）；问"咱们的暗号是什么来着？"这类问题，agent 会自主查记忆召回原文

## 核心能力

| 能力 | 说明 |
|---|---|
| 一键迁移 | 跨 6 个 agent 会话历史 → 结构化记忆（真实数据：322 会话 → 630+ 记忆，中途崩溃可续跑） |
| 质量管线 | 规则抽取 + 噪音闸门 + LLM 精炼判决（走 dsh 配置的模型；失败降级纯规则） |
| 混合召回 | 向量 KNN + BM25 RRF 融合；记忆带强化/衰减/推翻链演化 |
| 任务轨迹 | TodoWrite + git 维度（branch/changed）；"昨天卡在哪"可查 |
| 完成回流 | 任务完成瞬间卡点+解法自动入记忆库 |
| 跨 agent 交接 | ⇪ 推送会话进收件箱 → 任一 agent 开局取件（消费即弃）；MCP 16 工具 |
| Memoryfields 镜像 | `hippo memoryfield export` 每条记忆一个 Markdown 文件，可 grep / git 同步 / 生态互通 |
| 完整工作台 | 记忆 / 会话 / 蒸馏 / 编译 / 图谱 / 时间线 / 团队 / 生活流 11 页 |

## LLM 模型

蒸馏精炼与生活流居民跟随 dsh 的默认模型配置（settings.yaml `agent-default-model`）。推荐 MiniMax Token Plan（Anthropic 兼容端点）或任意本地 ollama 模型；LLM 不可用时自动降级纯规则，功能不中断。

## 文档

- 完整测试报告：[docs/test-report-2026-09-03.md](../docs/test-report-2026-09-03.md)
- 架构：[docs/hippo-dual-store-2026-09-01.svg](../docs/hippo-dual-store-2026-09-01.svg)
- 计划追踪：[docs/task-handoff-plan.md](../docs/task-handoff-plan.md)

## License

MIT
