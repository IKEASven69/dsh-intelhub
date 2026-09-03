# 🦛 Hippo Context

**Local-first experience engine for AI coding agents — sessions in, context out.**

你的 agent 已经学过这些：端口为什么是 3456、auth 模块为什么不能重构、部署清单哪一步总是漏。Hippo 把这些沉淀成**可检索、可交接、可演化的上下文层**——agent 是租客，来了取、干活时还、走了不带走。

本地优先 · 零 API key · 零遥测 · 数据永远是你的（Memoryfields 开放格式镜像）。

## 安装

```bash
npm i -g hippo-context
hippo gui        # 打开桌面工作台（浏览器）
```

> 原生模块（zvec/better-sqlite3）需要构建脚本放行：pnpm 用户执行 `pnpm approve-builds`；npm 用户正常安装。
> 首次蒸馏/召回自动下载 bge-m3 嵌入模型（约 2GB，国内建议配置 HF 镜像）。

## 三分钟体验

```bash
# 1. 把本机 agent 会话史蒸馏成记忆（真实数据：322 会话 → 630+ 记忆）
hippo distill --apply

# 2. 语义召回
hippo recall "这个项目状态管理用什么方案"

# 3. 编译进 AGENTS.md，agent 开局自动携带
hippo compile

# 4. 导出 Memoryfields 镜像（每条记忆一个 Markdown，可 grep / git 同步）
hippo memoryfield export --dir ~/hippo-mirror
```

或者打开桌面工作台（`hippo gui`）：记忆 / 会话 / 蒸馏 / 编译 / 图谱 / 时间线 / 模式 / 团队 / 居民 / 诊断 共 11 页。

## MCP 接入

任意 MCP 宿主（Claude Code / Codex / zcode / 自建 agent）注册 stdio server：

```json
{ "command": "hippo", "args": ["serve"] }
```

16 个工具：`memory_recall` / `memory_remember` / `handoff_inbox` / `handoff_load` / `task_list` / `task_update` / `compile` / `sleep` / `supersede` …

## 核心概念

| 能力 | 说明 |
|---|---|
| 双份存储 | MD 原文层（透明可移植，Memoryfields 规范）+ zvec 知识库（语义引擎）；互为备份 |
| 质量管线 | 规则抽取 + 噪音闸门 + LLM 精炼判决（配了 LLM 自动提质，没配降级纯规则） |
| 治理自动化 | 去重 / 强化 / 衰减 / 推翻链；每日自动 sleep 整合；待审队列 LLM 预审打建议 |
| 任务轨迹 | TodoWrite + git 维度（branch/changed）；完成自动回流记忆 |
| 跨 agent 交接 | push 会话进收件箱 → 任一 agent 开局取件（消费即弃，≤500 token + 原文指针） |

## 与 dsh-hippo 的关系

同一个引擎的 dsh 插件发行版（dsh market 安装，深度集成 dsh 会话/设置/工作台）。桌面端与插件共享 `~/.hippo` 数据格式，但可独立使用。

## 文档

- 架构与测试报告：[GitHub 仓库 docs/](https://github.com/IKEASven69/dsh-plugin/tree/main/docs)
- Memoryfields 规范：[memoryfield-spec](https://github.com/calpaterson/memoryfield-spec)

## License

MIT
