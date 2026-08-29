# dsh-deck 0.2.0 全量回归报告

> 生成：2026-08-30 · vitest 43/43 · Playwright 浏览器实测 · 零已知 bug

## 一、单元测试（43/43 ✅）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| security.spec.ts | 12 | Origin 校验 / 点路径放行(.git) / 穿越拦截(..) / 盘符 / NUL / 空段 / 包含性复核 |
| protocol.spec.ts | 5 | 项目 CRUD / 根外 folder 拒绝 / 内置不可删 / id 已存在 |
| d2.spec.ts | 6 | frontmatter 往返 / FTS5 中文子串+增量 / 短词 LIKE 回退 / 点子捕获/采纳 |
| d3.spec.ts | 8 | TASK.md 多卡解析/序列化往返稳定 / upsert / 状态机 / id 生成 / AGENTS.md v2 升级 |
| d3-review.spec.ts | 7 | RESULT 判断/来源小节 / widget 防御解析 / LESSONS 中文序号续接 |
| d4.spec.ts | 5 | 内容扫描/建项去重/三形态模板/状态流转/预填文本/发布记录追加 |

## 二、浏览器全动线（v4 五台 · 14 断言 + 写入闭环 6 断言 · 全过 ✅）

### 读路径
| 步骤 | 断言 | 结果 |
|---|---|---|
| 进门总台 | 聚合数据（进行中的件+灵感流） | ✅ |
| 知识库速览 | 统计卡+收藏Top+关注6条带徽章+判断回看 | ✅ |
| 审阅台 | 空态正常 | ✅ |
| 内容台 | 流水线四列+详情弹窗开合 | ✅ |
| PPT 放映 | P1/6 渲染→ArrowRight 翻到 P2→O 概览 6 页→Esc 退出 | ✅ |
| 文章阅读 | 780px 排版+退出 | ✅ |
| 调研台 | 任务队列+双通道按钮（终端/会话） | ✅ |
| 消息台 | 占位说明 | ✅ |
| 待办直达 | 总台待办点击→知识库审阅台 | ✅ |
| 右栏 | 会话条渲染+margin 让位宽度生效 | ✅ |
| 主题 | 四主题切换（glass/term/cyber/paper） | ✅ |
| 零 JS 错误 | 全程 | ✅ |

### 写入闭环（种测试卡→验后清理零残留）
| 步骤 | 断言 | 结果 |
|---|---|---|
| 种任务卡+RESULT | API 创建 | ✅ |
| 总台待办出现 | review 卡展示 | ✅ |
| 点待办直达审阅 | kbPendingTab 消费机制 | ✅ |
| 勾选+落库 | LESSONS 追加验证条 | ✅ |
| git 提交 | 知识库新 commit | ✅ |
| 任务卡置 done | 磁盘实证 | ✅ |
| 清理 | git revert + 删卡 + 删 RESULT | ✅ |

## 三、关键修复记录

| bug | 根因 | 修复 |
|---|---|---|
| 文库点文件夹「非法穿越」 | `startsWith('.')` 一刀切拒点路径 | 删冗余前缀规则，段级+包含性已防穿越 |
| 发给 zcode 调不动 | 固定 node 路径，TUI 在裸 cmd 体验差 | 启动器配置化（opencode 默认/zcode/custom+目录） |
| 总台「去审阅」死路 | kbGoTab 被 setTab 覆盖，冷启动时 null | kbPendingTab 消费机制 |
| PPT 放映白屏 | early return 在 useEffect 前→hooks 数量变→React 静默崩溃 | 移到所有 hooks 后 |
| 双 iframe 重复 | widget 挂载+html 自动发现指向同一文件 | 去重排除 |
| 弹窗按钮被长内容压底 | 无 sticky | dk-modal.wide 操作行 sticky 贴底 |

## 四、已知限制

- 消息台为占位（评论收件+AI 起草是下一版本）
- 知识库台「任务」标签页无台签壳（组件缺 desk 结构）
- 发布预填的微博/X 真实点发需用户在场配合
- watchlist X/视频/书籍渠道为空（格式已适配，数据未填）

## 五、截图存档

`docs/audit/` 下 12 个 PNG：v4 五台各台截图 + PPT 放映/概览 + 写入闭环三步 + 主题切换
