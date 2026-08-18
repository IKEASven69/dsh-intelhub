# dsh-depsec

DeepSeek Harness（dsh）依赖安全审计插件：**漏洞 / 投毒 / 密钥 / SAST 四合一**。

对当前工作区项目做就地一站式安全体检，结果在 Web 设置页展示，完成后弹 Windows 原生通知，安装依赖时自动值守。

## 能力

| 模式 | 检测内容 |
|---|---|
| `vuln` 漏洞 | 官方审计查已知 CVE/GHSA（npm/pnpm/yarn/pip/cargo/go），支持一键 `audit fix` |
| `supply-chain` 投毒 | install 脚本扫描 + typosquatting 近名 + npm registry 联网信誉（发布时间/下载量/仓库） |
| `secrets` 密钥 | 高置信正则 + 香农熵 + git 历史，含 `.depsecignore` 白名单 |
| `sast` 代码 | 危险代码模式（eval/命令注入/XSS/弱哈希/反序列化等） |

- 🟢/🟡/🔴 判定横幅 + 危险度筛选 + 只看新增（基线 diff）
- 点击告警跳转打开源文件（VS Code goto，回退资源管理器）
- 导出 SARIF 2.1.0（可进 GitHub Code Scanning / CI 门禁）
- Windows 原生通知（静默，仅新高危弹窗）
- 安装依赖自动值守（监听 install/add 命令，自动投毒扫描）

## 安装

```sh
dsh plugin --profile web add dsh-depsec
```

## 使用

设置 → 依赖安全审计 → 选模式 → 点「运行」（可填目录，留空=当前工作区）。

白名单：在工作区根目录放 `.depsecignore`，每行一个子串（文件路径/包名），命中即忽略，`#` 开头为注释。

## 开发 / 构建

本包为标准 Cordis 插件（host `TypertRemoteService` + client `dsh.client` 双面），构建依赖 harness 工具链：

```sh
pnpm install
pnpm build          # tsdown 产出 lib/index.js + lib/client.js
```

`cordis.patch.yml`（经 package.json 的 `dsh.bundle.patch` 声明）把 host 服务插入 profile 合成；浏览器半由 `dsh.client` manifest + `exports["./client"]` 提供。

## 免责声明

自研正则密钥/SAST 是启发式分诊，召回与精度不如 gitleaks/semgrep；深度数据流分析建议接 semgrep。安装第三方插件即在本机运行第三方代码，风险自担。
