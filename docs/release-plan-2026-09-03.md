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
- [ ] `scripts/publish-both.mjs`：读同一构建产物 → 生成两份发布包
  - dsh-hippo：现 package.json 原样（name/files/dsh 字段）
  - hippo-context：替换 name/description/keywords（去 dsh 字段，加 AI-memory 叙事）；README 换 npm 版
  - `npm pack --dry-run` 双包体积/文件清单校验
- [ ] `hippo-context` 名占确认（npm view 已 ✅，发布时再正式 claim）
- **验收**：两份 .tgz 产出，文件清单不含对方私有物（dsh 包不含 npm README / npm 包不含 dsh 字段）

### M2 · 文档 `（0.5 天）`
- [ ] 主 README（dsh market 页 + 仓库门面）：两分钟故事（装→自检→一键迁移→开局认识你）+ 截图（工作台/⇪推送/取件详情）+ 前置条件（approve-builds / 2GB 模型 / HF 镜像）
- [ ] npm 版 README（hippo-context）：面向非 dsh 用户——`npm i -g hippo-context && hippo gui`、Memoryfields 互通、与 dsh 版关系说明
- [ ] CHANGELOG.md：0.1.0 → 0.3.0 归纳（H2 工具 → H7 交接 → H8 镜像 → H9 治理）
- **验收**：三个文档互相链接、无过时信息（引用 test-report）

### M3 · 干净环境装机自检 `（0.5 天）`
- [ ] 模拟新用户：空目录 + 双包 tgz 安装（pnpm/npm 各一遍）→ pnpm approve-builds → doctor 全绿 → 最小 import/recall → memoryfield export
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
