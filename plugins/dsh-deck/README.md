# dsh-deck · 个人工作台插件

> **你的知识、内容、agent——一个界面管完。** dsh 插件，本地优先，零云端依赖。

## 是什么

五台一屏的个人工作台，跑在 DeepSeek Harness (dsh) 里：

| 台 | 干什么 |
|---|---|
| 🏠 **总台** | 进门即全貌：待办审阅置顶、进行中的件（五步流）、灵感流横向滑动 |
| 🧠 **知识库** | 速览（统计卡/收藏Top热度排序/Skills/关注分渠道/判断回看）→ 全文搜索（FTS5 中文子串）→ 文库钻取 → 审阅落库 → 复盘 |
| 🎬 **内容台** | 选题看板四列 → 交给 agent（PPT/文章/视频）→ PPT 放映（键盘翻页/概览）→ 文章阅读 → 发布预填（微博/X 意图链） |
| 📡 **调研台** | 任务卡队列（TASK.md 协议）→ 双通道派发（终端 CLI / 宿主会话）→ RESULT.md 审阅 → 勾选落库 LESSONS.md + git 提交 |
| 💬 **消息台** | 各平台评论收件 + AI 起草（下一版本） |

右侧是**宿主原生 dsh 对话**（margin 挤位方案——不是画出来的假聊天），点会话条切换、拖分割条调宽度、收起/展开。

## 核心动线

```
灵感流 ─→ 升任务 ─→ 🚀终端 / 💬会话 ─→ agent 干活
                                              ↓
发布 ←─ 预填（人工点发）←─ PPT 放映/文章阅读 ←─ 审阅勾选落库（LESSONS + git）
```

**红线**：AI 永远不直接写知识库（勾选落库是唯一入口）；发布永远预填+人工点发。

## 双通道派发

| 通道 | 用法 | 适合 |
|---|---|---|
| 🚀 终端 CLI | opencode（默认）/ zcode / 自定义命令，可配启动目录 | 零 DS token，长时间任务 |
| 💬 宿主会话 | promptIntoSession 三级降级投递到绑定的 dsh 会话 | 便捷，看 agent 实时干活 |

## 快速开始

```bash
dsh plugin --profile web add "link:D:/coding/dsh-plugin/plugins/dsh-deck"
# 重启 dsh web → 刷新页面 → 侧栏底部 🗂️ 打开工作台
```

## 主题

左栏底部四个圆点：霓虹玻璃 / 磷光终端 / 赛博切角 / 纸感编辑室。

## 架构

```
src/
  index.ts        host 路由总装（22 个 API 端点，全过 Origin+根白名单+穿越检查）
  security.ts     安全校验（点路径放行/穿越拦截/8 单测）
  protocol.ts     项目 CRUD 纯函数
  content.ts      内容流水线（meta 状态机/三形态模板/预填文本/发布记录）
  tasks.ts        TASK.md 多卡协议（frontmatter+---分隔）
  review.ts       RESULT.md 解析/widget 防御解析/LESSONS 章节续接
  ideas.ts        点子库（一念一 md）
  quickview.ts    知识库速览聚合（stats/Skills/热度/关注/判断回看）
  search.ts       FTS5 trigram 中文全文搜索
client/
  client.js       静态 React 客户端（五台+右栏+双通道+放映+阅读+四主题）
tests/            43 单测全绿
```

## 协议

### 任务卡 TASK.md
```yaml
---
id: T-20260829-01
type: research
status: queued → running → review → done
engine: zcode
acceptance: 条目1；条目2
---
# 任务题目
正文
```

### 产物挂载 widget-result.json
```json
{"task":"T-xxx","windows":[{"target":"main","kind":"html","path":"./out.html"}]}
```

### 落库（唯一写通道）
审阅勾选 → 追加 `insights/LESSONS.md` 新章节（中文序号续接）→ git 提交 → 任务卡置 done

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| kbRoot | D:/coding/knowledge-base | 知识库根 |
| contentRoot | D:/coding/content | 内容根 |
| zcodeCli | D:/ProgrammingKit/Zcode/resources/glm/zcode.cjs | zcode CLI |

启动器偏好（CLI/目录）存 `~/.dsh/storages/dsh-deck.json`，界面点「🚀 发给 zcode」首次弹出选择器。

## 测试

```bash
npm test        # 43 单测
# 全量回归见 docs/audit/ 截图
```

## License

MIT
