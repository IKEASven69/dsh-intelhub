/**
 * dsh-hippo host 半：TypertRemoteService，H0 只提供 doctor 自检 RPC
 * （引擎可加载？原生模块就绪？存储库在哪？），失败给出放行/下载指引。
 * H1 起追加 /memory import 命令与 stats；H2 起注册 memory_recall 工具。
 * @module dsh-hippo
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { DoctorReport, DoctorRequest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hippo: HippoService
  }
}

/** 动态加载可选依赖：变量形式的 specifier 不参与静态类型解析，装载失败返回错误信息。 */
async function tryImport(spec: string): Promise<string | null> {
  try {
    await import(spec)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const NATIVE_BLOCKED_HINT =
  'pnpm 10 / npm 12 默认拦截依赖 install 脚本，原生模块的 prebuild 二进制因此未下载。放行方式：在插件安装目录执行 pnpm approve-builds 勾选 better-sqlite3 与 sqlite-vec（或在其 package.json 的 pnpm.onlyBuiltDependencies 中加入两者）后重装。已安装 dsh-depsec 的用户可在其面板用「写回放行清单」一键完成。'

/**
 * 记忆桥服务。Client→Host 调用（设置页面板）走这里。
 */
export class HippoService extends TypertRemoteService {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'hippo')
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.logger.info('dsh-hippo: 记忆桥已加载（H0 骨架，doctor 可用）')
  }

  @Remote('doctor')
  async doctor(request: DoctorRequest): Promise<DoctorReport> {
    void request
    const guidance: string[] = []

    const engineErr = await tryImport('hippo-skills')
    const sqliteErr = await tryImport('better-sqlite3')
    const vecErr = await tryImport('sqlite-vec')

    if (engineErr !== null) guidance.push(`引擎包 hippo-skills 加载失败：${engineErr}。请在插件目录重装依赖（pnpm install）。`)
    if (sqliteErr !== null || vecErr !== null) guidance.push(NATIVE_BLOCKED_HINT)

    const storePath = join(homedir(), '.hippo', 'memories.db')
    let storeExists: boolean | null = null
    try {
      storeExists = existsSync(storePath)
    } catch {
      storeExists = null
    }

    const checks = [
      { name: '引擎 hippo-skills', ok: engineErr === null, detail: engineErr ?? 'openEngine() 可用' },
      { name: '原生模块 better-sqlite3', ok: sqliteErr === null, detail: sqliteErr ?? 'prebuild 二进制正常' },
      { name: '原生模块 sqlite-vec', ok: vecErr === null, detail: vecErr ?? '向量扩展正常' },
      { name: '记忆库', ok: storeExists !== false, detail: storeExists === true ? storePath : storeExists === false ? '尚未创建（首次 import/recall 时自动建立）' : `无法探测：${storePath}` },
    ]

    return {
      ok: engineErr === null && sqliteErr === null && vecErr === null,
      checks,
      storePath,
      storeExists,
      modelNote: '首次 distill / recall 会自动下载 bge-m3 嵌入模型（约 2GB；国内网络建议预先配置 HF 镜像，详见 README）。',
      guidance,
    }
  }
}

export default HippoService
