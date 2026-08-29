/**
 * 恢复会话（G4）：按 agent 映射 CLI 恢复命令，GUI 只负责拼命令+拉起终端，
 * 不代理会话本身。Windows Terminal 优先，回退 conhost；cmd /k 保持窗口。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ResumePlan {
  command: string
  cwd: string
  note?: string
}

/** 各 agent 的恢复命令（未验证 CLI 的 agent 不给命令——按钮置灰并说明）。 */
export function resumePlanFor(agent: string, sessionId: string, cwd: string): ResumePlan | null {
  switch (agent) {
    case 'claude-code': {
      // 文件名即 <uuid>.jsonl
      const uuid = basename(sessionId, '.jsonl')
      return { command: `claude --resume ${uuid}`, cwd }
    }
    case 'codex': {
      // rollout-<时间戳>-<uuid>.jsonl → 取末段 uuid
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(sessionId)
      if (!m) return null
      return { command: `codex resume ${m[1]}`, cwd }
    }
    default:
      return null
  }
}

const WT_PATHS = [
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe'),
  'C:\Program Files\WindowsApps\wt.exe',
]

/** 拉起终端窗口执行命令（detached，不随引擎退出）。 */
export function launchTerminal(plan: ResumePlan): { ok: boolean; via: string; error?: string } {
  if (plan.cwd !== '' && !existsSync(plan.cwd)) {
    return { ok: false, via: '', error: `工作目录不存在：${plan.cwd}` }
  }
  const wt = WT_PATHS.find((p) => p !== '' && existsSync(p))
  try {
    if (wt !== undefined) {
      spawn(wt, ['-d', plan.cwd, 'cmd', '/k', plan.command], {
        detached: true,
        stdio: 'ignore',
        cwd: plan.cwd || undefined,
      }).unref()
      return { ok: true, via: 'Windows Terminal' }
    }
    spawn('cmd.exe', ['/c', 'start', 'hippo resume', '/D', plan.cwd || '.', 'cmd', '/k', plan.command], {
      detached: true,
      stdio: 'ignore',
      cwd: plan.cwd || undefined,
    }).unref()
    return { ok: true, via: 'conhost' }
  } catch (e) {
    return { ok: false, via: '', error: e instanceof Error ? e.message : String(e) }
  }
}
