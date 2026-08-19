# dsh-dashboard — DeepSeek Harness 活动仪表盘 & IM 桥接插件项目

本目录是「活动仪表盘」插件项目的**设计 + 蓝本仓库**（工作区，非 npm 包）。
动态 Cordis 插件是进程内对象、重启即失，本目录是唯一持久蓝本。

## 目录结构

```
dsh-dashboard/
├── README.md               # 本文件：项目入口与索引
└── docs/
    ├── design.md           # 全量功能点记录（已实现 / ACP 决策 / 增强方向 / 飞书 / 长期化计划）
    └── blueprint.md        # dash-1 长期化改写蓝本（host/client 源码快照 + 关键坑）
```

## 运行时状态

| 对象 | 状态 | 说明 |
|------|------|------|
| `dash-1` 活动仪表盘 | 运行中 `pkg-28` | host + client 双半 |
| `imbr-2` IM 桥接 | 运行中 `pkg-27` | workspace/session 分离 + 网页聊天 + 飞书推送 |

> 进程重启后按 `docs/blueprint.md` 重新 `cordis_define` / `cordis_run` 即可复原。
> 完整源码可用 `cordis_inspect_self('dash-1','pkg-28')` 取 `code.host` / `code.client` 原文。

## 功能点速览

详见 `docs/design.md`。核心：
- 活动监视器、Token 消耗 + 峰谷电价 CNY 成本、Skill 雷达、上下文压力趋势 + ACP 分析
- 每 agent 成本归因、编排拓扑、压缩摘要面板 + 主动压缩、CLI 启动器、高危命令自拦截
- 外部桥接（JSON/NDJSON/SSE）、IM 桥接（网页聊天 + 二维码 + 飞书推送）

## 待办优先级

1. **长期化 dash-1**（阶段 A：把 harness 原生 `compaction` 表面化 + 现有面板迁入 repo 插件 `packages/client/ui-dashboard`）。
2. 双向飞书（等 App ID/Secret）。
3. 仪表盘增强：Bug 卡片（对标 Claude Code TaskList）、任务交接（对标 Codex，走 `sessions.fork`）、自适应信息流。
4. 阶段 B（可选）：忠实移植 acp-kernel 治理层（多级块 + 可搜索 + 解压到文件）。
