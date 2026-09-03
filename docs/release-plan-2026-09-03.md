# H10 · 发布线：双包发布 + 文档 · 计划

> 立项：2026-09-03 ｜ 状态：**执行中**
> 目标一句话：同一份源码，两个发布面——`dsh-hippo`（dsh market 插件）+ `hippo-context`（npm 桌面端），发布物料一次备齐，publish 动作留给人。

## 0. 背景与决策记录

| 决策 | 内容 | 依据 |
|---|---|---|
| 双包不拆仓 | 仓库名 dsh-plugin（monorepo）不动；发布时构建两份包描述 | 拆仓 = 引擎同步负担；同源双包零成本 |
| npm 名 | **hippo-context**（冷神拍板方向，npm 已验证可注册） | 命中 H7 定位"上下文所有权层"；避开 memory 红海命名；hippo-memory 1.38.0 被占；hippo-mind 过泛 |
| bin 名 | `hippo`（两包一致） | 命令 continuity |
| 版本 | 0.3.0（H7 交接 + H8 memoryfield + H9 治理 = minor 级） | semver |
| publish 动作 | **人执行**（npm 谁的账号谁发）；脚本只做构建+pack+dry-run | 账号归属 |

## 1. 现状盘点（2026-09-03 核实）

| 项 | 状态 |
|---|---|
| 测试 | 148 单测全过 + T1-T12 全功能矩阵（docs/test-report-2026-09-03.md） |
| 功能 | H7 交接全里程碑 + H8 memoryfield + H9 敏感闸门/治理自动化 |
| UX | 工作台 11 页 + 收件箱面板 + 建议徽标/批量执行 + 结构化取件弹层 |
| LLM | minimax Token Plan（anthropic-messages 协议，think 块标准化） |
| 已知坑 | pnpm approve-builds（原生模块）；bge-m3 首次下载 2GB（HF 镜像提示已在 doctor） |

## 2. 里程碑

### M1 · 发布基础设施 `（0.5 天）`
- [x] `scripts/publish-both.mjs` ✅ 2026-09-03（keywords 写入修复；hippo-context exports 重映射包根→引擎）
  - dsh-hippo：现 package.json 原样（name/files/dsh 字段）
  - hippo-context：替换 name/description/keywords（去 dsh 字段，加 AI-memory 叙事）；README 换 npm 版
  - `npm pack --dry-run` 双包体积/文件清单校验
- [x] `hippo-context` 名占确认 ✅（npm view 404 = 可注册）
- **验收**：两份 .tgz 产出，文件清单不含对方私有物（dsh 包不含 npm README / npm 包不含 dsh 字段）

### M2 · 文档 `（0.5 天）`
- [x] 主 README ✅ plugins/dsh-hippo/README.md（两分钟上手 + 能力表 + LLM 说明 + 文档链接）
- [x] npm 版 README ✅ README-npm.md（安装/三分钟体验/MCP 接入/核心概念/dsh 关系）
- [x] CHANGELOG.md ✅ 0.3.0/0.2.0/0.1.0 三版归纳
- **验收**：三个文档互相链接、无过时信息（引用 test-report）

### M3 · 干净环境装机自检 `（0.5 天）`
- [x] 模拟新用户 ✅ hippo-context tgz（1.8M）干净目录安装：--version 0.3.0 / doctor healthy / remember+recall 全通；pnpm 侧安装警告与 README 指引一致
- [ ] HIPPO_DATA_DIR 隔离，不碰真库
- **验收**：零文档依赖跑通；卡点全部回填 README

### M4 · dsh market 提交材料 `（0.5 天）`
- [ ] 市场页元数据：名称/简介/图标/分类/链接
- [ ] 提交流程确认（dshmarket 1.24 的上架要求）
- **验收**：材料齐，提交动作留给人

## 3. 出界

- ❌ 真正执行 npm publish / market 上架点击（人做）
- ❌ 会话语义检索、fidelity bench（发布后按反馈排）

## 4. 追踪

每次收工在 §5 追加一行；范围变更改上文并记录。

## 5. 变更日志

- 2026-09-03 立项：双包发布 + 文档规划。npm 名 hippo-context 拍板（可注册已验证）。

## 5. 变更日志

- 2026-09-03 M1/M2/M3 完成（commit be55c5e+）：publish-both.mjs 双包构建（keywords/exports 重映射修复）、双 README + CHANGELOG、干净装机自检全通。测试抓出并修复：CLI/MCP 硬编码版本号 0.2.0 在 0.3.0 包里漏出 → 动态读取 package.json。剩余 M4 market 提交材料 + 真实 publish 动作（人执行）。
- 2026-09-03 立项：双包发布 + 文档规划。npm 名 hippo-context 拍板（可注册已验证）。