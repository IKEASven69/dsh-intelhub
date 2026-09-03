# Changelog

## 0.3.0 (2026-09-03)

### 引擎内置 + 双形态
- 引擎并入插件包（原 hippo-mind 独立包归档）：dsh 插件 + `hippo gui` 桌面端同源
- 完整工作台挂进 dsh：`/dsh-hippo/app` 桥接全 API，设置页降级为配置入口

### H7 · 交接与任务
- 任务状态加厚：git 维度（branch/changed）+ 两层轨迹（活跃快照 + sessionId 归档）
- 完成回流：任务完成自动蒸馏卡点+解法进记忆库
- WorkBuddy 适配器（第 6 个 agent 源）
- 交付通道：⇪ 推送收件箱（消费即弃）+ MCP handoff_inbox/handoff_load + skill 三份

### H8 · Memoryfields 镜像
- `hippo memoryfield export/import`：每条记忆一个 Markdown（规范合规），grep 可查、git 可同步、roundtrip 去重闭环

### H9 · 治理与安全
- 敏感信息闸门：9 类 key/凭证模式写入即拒；`hippo secrets` 存量扫描
- 待审队列 LLM 预审（建议收/弃+理由）；每日自动 sleep 整合
- 蒸馏噪音闸门（过程自语/标题/样板文拦截）+ LLM 精炼判决（可选，降级纯规则）

### 基建
- LLM 统一桥：dsh 配置模型优先（含思考模型 think 剥离）→ ollama 兜底
- 存储澄清：zvec 为唯一记忆存储；better-sqlite3 仅会话索引；sqlite-vec 移除
- 双入口共存（独立 GUI + dsh 桥接）不撞锁；148 测试全过

## 0.2.0 (2026-08-31)

- 记忆编译自动化闭环（记忆变更→AGENTS.md 自动重编译）
- GUI 状态栏（蒸馏状态/待审/自动编译）+ Workflow 传送
- 自然语言场景验证：零工具名提问 → agent 自主召回

## 0.1.0 (2026-08-21)

- 首个 dsh 插件形态：自检 / 一键迁移 / memory_recall / 设置面板
