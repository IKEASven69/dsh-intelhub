/**
 * 引用计数的引擎持有者（G2 读写分离的核心）。
 *
 * 背景：zvec 是单写锁且无只读打开形态；server-http 原设计长持引擎，
 * `hippo gui` 一开就把锁占死，dsh 插件侧一切 openEngine 操作全部失败。
 *
 * 方案：按请求短持——acquire() 在引用数 0→1 时 openEngine；release()
 * 归零后不立即 close，先进入 IDLE_GRACE_MS 空闲宽限（dsh 插件 K3 每分钟
 * 点醒这类高频短请求，归零即关会陷入开→关→开震荡，每次开都要重新
 * 加载 zvec 索引）；宽限期内新 acquire 零开销复用并取消关闭。有外部
 * 等待者（另一消费者在抢锁）时立即关闭、不吃宽限，礼让语义不变。
 * 锁被占时限时重试（GUI 与 dsh 插件互相礼让的窗口从"永远"缩到毫秒级）。
 * 嵌入模型在模块级缓存（extractorPromise），开关引擎不重载模型。
 */

import { openEngine } from './engine.js'
import type { MemoryEngine } from './memory.js'
import type { ZvecStore } from './zvec-store.js'

export interface HeldEngine {
  engine: MemoryEngine
  store: ZvecStore
  /** 归还引用；引用归零后（经空闲宽限）真正关锁。 */
  release(): void
}

/** 归零后保持锁开启的宽限。10s 覆盖分钟级 tick 的高频短请求，又不会
 * 长期占锁——有等待者时立即关闭，不受宽限影响。 */
const IDLE_GRACE_MS = 10_000

let current: { engine: MemoryEngine; store: ZvecStore; refs: number } | null = null
let waiters: Array<() => void> = []
let idleTimer: ReturnType<typeof setTimeout> | null = null

function isLockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('lock') || msg.includes('LOCK')
}

/** 真正执行关闭并唤醒等待者。 */
function closeNow(): void {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  const closing = current
  current = null
  try { closing?.store.close() } catch { /* 关锁失败不致命 */ }
  const pending = waiters
  waiters = []
  for (const w of pending) w()
}

function tryOpen(): void {
  if (current !== null) return
  try {
    const opened = openEngine()
    current = { engine: opened.engine, store: opened.store, refs: 0 }
  } catch (e) {
    if (!isLockError(e)) throw e
    // 锁被占：留给重试循环处理
  }
}

/**
 * 取一个引擎引用。锁被另一消费者占用时每 250ms 重试，超过 timeoutMs 抛错。
 */
export async function acquireEngine(timeoutMs = 10000): Promise<HeldEngine> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // 宽限期内复用：取消挂起的关闭，省一次 openEngine（zvec 索引加载）
    if (idleTimer !== null && current !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    tryOpen()
    if (current !== null) {
      current.refs += 1
      return {
        engine: current.engine,
        store: current.store,
        release: () => {
          if (current === null) return
          current.refs -= 1
          if (current.refs > 0) return
          if (waiters.length > 0) {
            // 有等待者（另一消费者在抢锁）：立即礼让，不吃宽限
            closeNow()
          } else {
            // 无人等待：进宽限期，期间新请求零开销复用
            if (idleTimer === null) {
              idleTimer = setTimeout(() => { idleTimer = null; if (current !== null && current.refs <= 0) closeNow() }, IDLE_GRACE_MS)
              idleTimer.unref?.()
            }
          }
        },
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`engine-holder: 存储锁被占用（等待 ${timeoutMs}ms 超时）——另一消费者（dsh 插件/hippo gui）正在写入`)
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
      setTimeout(resolve, 250)
    })
  }
}

/** 请求包裹：acquire → fn → release，异常也保证归还。 */
export async function withEngine<T>(fn: (held: HeldEngine) => Promise<T>, timeoutMs?: number): Promise<T> {
  const held = await acquireEngine(timeoutMs)
  try {
    return await fn(held)
  } finally {
    held.release()
  }
}
