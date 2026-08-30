# dsh-trust-list

Dependency trust list for DeepSeek Harness — when `pnpm install` blocks an install script, `dsh-trust-list` audits every script in the block, grades them PASS/WARN/BLOCK with file-line evidence, and rewrites `pnpm.onlyBuiltDependencies` (and bun `trustedDependencies`) with only the packages whose scripts are verifiably safe. One click, no `pnpm audit` raw-output reading.

`pnpm` ≥ 10 and `npm` ≥ 12 block install scripts by default — that's good, but the user is left staring at `ERR_PNPM_IGNORED_BUILDS: esbuild, koffi` with no idea which of those is safe to approve. `dsh-trust-list` is the answer: scan, read the actual script, decide.

## What it does

- **`vuln`** — run `npm/pnpm/yarn audit`, `pip-audit`, `cargo audit`, or `govulncheck` against the project; surface CVE/GHSA hits with severity and fix-availability; one-click `audit fix` for npm-family.
- **`trust-list`** — read every install script in the block; grade each with **PASS / WARN / BLOCK**; show the script content and the exact file:line evidence; one-click rewrite of `pnpm.onlyBuiltDependencies` and `trustedDependencies` with only the PASS-graded packages.
- **`secrets`** — high-confidence regex + Shannon entropy + last 20 git commits; `.depsecignore` honored.
- **`sast`** — base rule set (eval / command injection / innerHTML / `shell=True` / weak hashes / deserialization); for depth, wire in `semgrep` separately.
- **`plugin roster`** — audit every bundle installed in the current profile; per-plugin PASS/WARN/BLOCK summary; SARIF export for CI.

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
- **写回覆盖**（2026-08 核实键名）：package.json 的 `pnpm.onlyBuiltDependencies`（pnpm 10）与 `trustedDependencies`（bun）、pnpm 11 的 pnpm-workspace.yaml `allowBuilds`（名→布尔映射，与 deepseek-harness 官方参考文档一致）、npm 12 的 package.json `allowScripts`——四处一并写回，无需手动同步。两条边界：你在任何一处写下的显式 `false`（拒绝）永不翻转、也不入单；`allowScripts` 写 name 条目而非 `pkg@version` pinned（npm 自己的 approve-scripts 默认 pinned，需要钉版本用 `npm approve-scripts`）。
- `plugin roster` audits by walking the profile directory — it sees what pnpm has materialized. Plugins installed via `link:` (local source), `file:`, or `git:` are scanned against their on-disk tree; a fresh source clone with a build step that pnpm already gated is graded against the **source** state, not the built artifact.

## Building from source

Standard Cordis plugin (host `TypertRemoteService` + client `dsh.client`).

```sh
pnpm install            # only build/test deps — peers are injected by the dsh runtime
pnpm test               # vitest: install-script corpus + audit-output parsers + trust write-back (46 cases)
node .build-tools/build.cjs   # local verification build: SWC (stage-3 decorators) + esbuild
```

没有 dsh 运行时的环境（CI / 贡献者本机）：`pnpm install --config.auto-install-peers=false`，避免 pnpm 自动安装未公开发布的 `@deepseek-ai/*` peers 导致整树 404。首次 install 后 pnpm 11 会留下 `allowBuilds` 占位提示，把 `@swc/core` 与 `esbuild` 填为 `true`（或交互式 `pnpm approve-builds`）——这正是本插件替用户回答的那道题。

`@deepseek-ai/*` is never a devDependency here — its transitive deps include unpublished packages and the whole tree 404s on install.

`cordis.patch.yml` (referenced via `dsh.bundle.patch`) inserts the host service into profile composition; the browser half ships via the `dsh.client` manifest + `exports["./client"]`.

## Disclaimer

Self-rolled regex for secrets and SAST is a triage heuristic — recall and precision trail `gitleaks` and `semgrep`. For depth dataflow analysis, wire in `semgrep`. Installing a third-party plugin runs third-party code on your machine; the trust list tells you which scripts are *evidently* safe, not which plugins are *trustworthy*.