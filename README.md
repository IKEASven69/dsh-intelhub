# dsh-plugin/ — DeepSeek Harness 插件集中地

> 2026-08-18 建立。以后所有 dsh 相关插件都放这里，别再散在 `D:\coding\` 根目录。

## 结构

```
dsh-plugin/
├── plugins/     # 自己开发的插件
│   ├── dsh-depsec/        # 依赖安全审计（漏洞/投毒/密钥/SAST 四合一）
│   ├── agentforge-brain/  # 会话 3D 大脑可视化
│   ├── dsh-dashboard/     # 活动仪表盘 & IM 桥接（设计蓝本仓库）
│   ├── dsh-polymarket/    # Polymarket 插件
│   └── polymarket-cordis/ # cordis overlay 实验
├── vendor/      # 别人开发的插件（clone 下来参考/使用；嵌套 git 仓库不入库，仅本机存在）
└── docs/        # dsh 相关资料（awesome-dsh 中文版、UI 调试快照）
```

## 注意事项

- **deepseek-harness 不在这里**：它是平台本体（官方仓库 clone），不是插件，仍在 `D:\coding\deepseek-harness`
- **已安装插件用 link: 指向绝对路径**：`~/.dsh/profiles/web/package.json` 里 `link:D:/coding/...` 的引用。移动/改名本目录下的插件后要同步改那个文件，再 `cd ~/.dsh/profiles/web && pnpm install` 刷新链接（2026-08-18 重组时已做过一次；**2026-08-19 目录英文化 `自己的/`→`plugins/`、`三方/`→`vendor/`，另一台机器记得同步改 link 路径并把本地 `三方/` 手动改名为 `vendor/`**——它是不入库的嵌套仓库，git 帮不上）
- 新立项的自己的插件直接在 `plugins/` 下建目录；clone 三方的进 `vendor/`
- 目录名一律英文（中文路径会导致 git 八进制转义显示、部分工具链/CI/glob 兼容问题，且不利于对外发布）
- dsh 官方还在 developer preview（breaking changes 常态），适配类改动前先看官方 changelog
