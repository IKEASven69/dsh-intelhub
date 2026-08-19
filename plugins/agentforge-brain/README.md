# dsh-agentforge-brain

AgentForge Brain：给 dsh Web GUI 的会话视图加一个「🧠 大脑」tab，把当前会话的事件流（用户消息 / 助手文本 / 推理 / 工具调用 / 工具结果）投影成一个缓慢旋转的 3D 记忆大脑——一个节点对应一个事件，节点大小与深度表示其在球面上的位置，边连接相邻事件。

这是一个可安装的 **bundle**：`dsh.bundle` 提供 patch 层，`dsh.client` 提供浏览器半。

## Install

```sh
# 本地目录安装（也支持 github:you/repo、npm 包名或 .tgz）
dsh plugin --profile web add ./agentforge-brain

# 启动 Web GUI
dsh web
```

从源码 checkout 运行时，把 `dsh` 换成 `pnpm dsh`。

安装后打开 `http://127.0.0.1:3080`，会话顶部会出现「🧠 大脑」tab。

## Uninstall

```sh
dsh plugin --profile web remove dsh-agentforge-brain
```

## Notes

- 浏览器半通过 `ctx.slots.inject('conversation.view', …)` 注册 tab，随插件 fiber 自动卸载。
- 颜色使用主题 token（`--dsw-*`），自动跟随明/暗主题。
- host 半为空：本插件不提供任何宿主端行为，也不给模型新增工具或 prompt。
