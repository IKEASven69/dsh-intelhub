# dsh-trust-list

Dependency trust list for DeepSeek Harness — when `pnpm install` blocks an install script, `dsh-trust-list` audits every script in the block, grades them PASS/WARN/BLOCK with file-line evidence, and rewrites `pnpm.onlyBuiltDependencies` (and bun `trustedDependencies`) with only the packages whose scripts are verifiably safe. One click, no `pnpm audit` raw-output reading.

`pnpm` ≥ 10 and `npm` ≥ 12 block install scripts by default — that's good, but the user is left staring at `ERR_PNPM_IGNORED_BUILDS: esbuild, koffi` with no idea which of those is safe to approve. `dsh-trust-list` is the answer: scan, read the actual script, decide.

## What it does

- **`vuln`** — run `npm/pnpm/yarn audit`, `pip-audit`, `cargo audit`, or `govulncheck` against the project; surface CVE/GHSA hits with severity and fix-availability; one-click `audit fix` for npm-family.
- **`trust-list`** — read every install script in the block; grade each with **PASS / WARN / BLOCK**; show the script content and the exact file:line evidence; one-click rewrite of `pnpm.onlyBuiltDependencies` and `trustedDependencies` with only the PASS-graded packages.
- **`secrets`** — high-confidence regex + Shannon entropy + last 20 git commits; `.depsecignore` honored.
- **`sast`** — base rule set (eval / command injection / innerHTML / `shell=True` / weak hashes / deserialization); for depth, wire in `semgrep` separately.
- **`plugin roster`** — audit every bundle installed in the current profile; per-plugin PASS/WARN/BLOCK across four dimensions (supply-chain / secrets / sast / **prompt-injection**); model-facing text (SKILL.md / commands / agents) is scanned for injection content — the #1 dsh-plugin attack vector that every other scanner skips; static egress destination inventory; post-install hash lock (files changed since last scan → re-audit finding); SARIF export for CI.
- **version lock** — every audit records `pkg → {version, install-scripts fingerprint, verdict}` in `.depsec-baseline.json`; when a dependency upgrades **and its scripts changed**, the old PASS no longer carries over — you get a “依赖版本变更重审” finding instead. This closes the coa/rc-style hijack path where a name-level allowlist survives a malicious republish. The same fingerprinting covers **installed plugins** (hash lock: files changed after install → “已装插件文件变更”).

Plus: Windows notification on new high-severity hits; baseline diff so the 200th audit only shows what's *new*; click-to-open in VS Code (falls back to Explorer).

## Install

```sh
dsh plugin --profile web add dsh-trust-list
```

Settings → **Trust List** → pick a mode → **Run**. Leave the path empty to scan the current workspace.

## How the trust-list mode decides PASS / WARN / BLOCK

| Verdict | Trigger |
|---|---|
| **PASS** | Script matches known-good patterns (node-gyp / prebuild-install / husky / pure local file ops / pure echo). |
| **WARN** | Script touches shell or environment in unfamiliar ways; or there is a typosquat candidate (Levenshtein 1–2 against an 80-name popular-packages list, **not exhaustive**); or registry shows <30 days old or <100 downloads. |
| **BLOCK** | Script does `curl … | sh` to an IP or unknown host, prints env vars to a network sink, decodes a base64/encoded payload into a shell or node, or posts to a paste/discord/telegram webhook. |

- `trust-list` mode reads every install script in the block, grades each **PASS / WARN / BLOCK**, and one-click rewrites all four approval stores: package.json `pnpm.onlyBuiltDependencies` (pnpm 10), `pnpm-workspace.yaml` `allowBuilds` (pnpm 11), package.json `allowScripts` (npm 12), and `trustedDependencies` (bun) — PASS-graded packages only.

## Honest limits

- `typosquatting` checks against a hand-curated list of 80 popular package names — typos outside that list are not detected. This is a triage signal, not a registry integrity proof.
- `sast` ships 9 base rules. Depth and dataflow analysis are not in scope; for serious code-audit work, wire in `semgrep` or `codeql`.
- `secrets` regex + entropy is a triage signal. The same shape a real key uses is also what high-entropy placeholders look like — expect false positives on test fixtures; use `.depsecignore` for them.
- **写回覆盖**（2026-08 核实键名）：package.json 的 `pnpm.onlyBuiltDependencies`（pnpm 10）与 `trustedDependencies`（bun）、pnpm 11 的 pnpm-workspace.yaml `allowBuilds`（名→布尔映射，与 deepseek-harness 官方参考文档一致）、npm 12 的 package.json `allowScripts`——四处一并写回，无需手动同步。两条边界：你在任何一处写下的显式 `false`（拒绝）永不翻转、也不入单；`allowScripts` 写 name 条目而非 `pkg@version` pinned（npm 自己的 approve-scripts 默认 pinned，需要钉版本用 `npm approve-scripts`）。**版本漂移由 version lock 兜底**：放行是包名级的，但每次审计会记录版本+脚本指纹，升级换脚本会触发「依赖版本变更重审」，不会静默沿用旧结论。
- `plugin roster` audits by walking the profile directory — it sees what pnpm has materialized. Plugins installed via `link:` (local source), `file:`, or `git:` are scanned against their on-disk tree; a fresh source clone with a build step that pnpm already gated is graded against the **source** state, not the built artifact.

## 语料回归跑分（2026-08-31）

**大规模实测**：npm 人气 top 1814 包中的 446 条 install 生命周期脚本，**tarball 全链路**（提取被引用脚本文件 + 解析 `npm run` 委派，对齐真实安装场景；采集与评测脚本见 `research/`，方法学报告 `research/2026-08-29-语料调研报告.md`）：

| 指标 | 结果 |
|---|---|
| 误拦截（top 包被判 BLOCK） | **0** |
| 误警告率 | 7%（修复前 75%——"未能识别的命令"误警已按真实语料聚类修掉） |
| 漏报探针（9 种真实投毒 TTP：`node -e` 混淆载荷 / child_process 拼接域名 / Chrome 凭据窃取 / 下载→chmod→执行链 等） | **9/9 拦截** |

**提示注入内容检测**（v0.5 新增，扫描 SKILL.md/commands/agents 模型面文本——四家同类工具均不读的盲区）：

| 语料 | 条数 | 结果 |
|---|---|---|
| 双语恶意 TTP（凭据外传+隐蔽、伪权威覆盖、持久化渗透、解码执行、零宽/同形字/base64 变体） | 14 | **0 漏报**（block 或 warn） |
| 真实技能文件（本地 560 个 SKILL.md/commands：baoyu 系、apify 系、gsd、hippo 等生产技能） | 560 | **0 误报**（pass 560） |

设计要点（详见 `research/2026-09-01-v0.5设计文档.md`）：凭据外传类规则要求「凭据语境 + URL/webhook 靶标」双命中才判 critical；代码围栏与内联反引号内的命中降级（技能教学 curl/git 是常态）；「`--force` to bypass safety gates」这类 flag 能力描述自动豁免；同形字/零宽字符/base64 变体归一化后复扫。

单元/回归语料（`tests/`）：

| 语料 | 条数 | 结果 |
|---|---|---|
| 良性安装器（node-gyp / prebuild / husky / esbuild 式下载器 / `npm run` 委派 / 构建工具链） | 19 | 19 pass，**0 误报 block** |
| 公开投毒手法（curl\|sh、env POST 外传、eval 载荷、裸 IP、敏感路径、持久化、无域名混淆） | 13 | 13 BLOCK，**0 漏报** |
| 灰色地带（子进程 + 陌生镜像域名、`npx` 远端包、文件未读取） | — | warn 转人工 |

语料即 `tests/corpus-regression.test.ts`——改检测逻辑先过这里，数字变了先解释。GitHub Actions 每周一自动重拉语料回归（`.github/workflows/trust-list-corpus.yml`）：误拦截非 0、探针漏报即红灯。

## Building from source

Standard Cordis plugin (host `TypertRemoteService` + client `dsh.client`).

```sh
pnpm install            # only build/test deps — peers are injected by the dsh runtime
pnpm test               # vitest: install-script corpus + audit-output parsers + trust write-back + version lock (124 cases)
node .build-tools/build.cjs   # local verification build: SWC (stage-3 decorators) + esbuild
```

判定质量评测三件套（`research/`）：`collect.mjs` 拉 npm top 包语料 → `run.mjs` 全量判定 → `probe-evasion.mjs` 漏报探针；`run-tarball.mjs` 为 tarball 全链路版。方法学与数字见 `research/2026-08-29-语料调研报告.md`。

没有 dsh 运行时的环境（CI / 贡献者本机）：`pnpm install --config.auto-install-peers=false`，避免 pnpm 自动安装未公开发布的 `@deepseek-ai/*` peers 导致整树 404。首次 install 后 pnpm 11 会留下 `allowBuilds` 占位提示，把 `@swc/core` 与 `esbuild` 填为 `true`（或交互式 `pnpm approve-builds`）——这正是本插件替用户回答的那道题。

`@deepseek-ai/*` is never a devDependency here — its transitive deps include unpublished packages and the whole tree 404s on install.

`cordis.patch.yml` (referenced via `dsh.bundle.patch`) inserts the host service into profile composition; the browser half ships via the `dsh.client` manifest + `exports["./client"]`.

## Disclaimer

Self-rolled regex for secrets and SAST is a triage heuristic — recall and precision trail `gitleaks` and `semgrep`. For depth dataflow analysis, wire in `semgrep`. Installing a third-party plugin runs third-party code on your machine; the trust list tells you which scripts are *evidently* safe, not which plugins are *trustworthy*.