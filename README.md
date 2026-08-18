# dsh-plugin/ — DeepSeek Harness 插件集中地

> 2026-08-18 建立。以后所有 dsh 相关插件都放这里，别再散在 `D:\coding\` 根目录。

## 结构

```
dsh-plugin/
├── 三方/        # 别人开发的插件（clone 下来参考/使用）
│   └── dsh-routing-suite/
├── 自己的/      # 自己开发的插件
│   ├── dsh-depsec/        # 依赖安全审计（漏洞/投毒/密钥/SAST 四合一）
│   ├── agentforge-brain/  # 会话 3D 大脑可视化
│   ├── dsh-dashboard/     # 活动仪表盘 & IM 桥接（设计蓝本仓库）
│   ├── dsh-polymarket/    # Polymarket 插件
│   └── polymarket-cordis/ # cordis overlay 实验
└── docs/        # dsh 相关资料（awesome-dsh 中文版、UI 调试快照）
```

## 注意事项

- **deepseek-harness 不在这里**：它是平台本体（官方仓库 clone），不是插件，仍在 `D:\coding\deepseek-harness`
- **已安装插件用 link: 指向绝对路径**：`~/.dsh/profiles/web/package.json` 里 `link:D:/coding/...` 的引用。移动/改名本目录下的插件后要同步改那个文件，再 `cd ~/.dsh/profiles/web && pnpm install` 刷新链接（2026-08-18 重组时已做过一次）
- 新立项的自己的插件直接在 `自己的/` 下建目录；clone 三方的进 `三方/`
- dsh 官方还在 developer preview（breaking changes 常态），适配类改动前先看官方 changelog
