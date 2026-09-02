/**
 * 知识库全流程集成测试:cordis 裸 Context + 真实 zvec 存储 + 假向量器。
 * 覆盖:文件夹导入(含跳过目录/不支持扩展名)→ 检索(FTS 腿命中)→ 列表 → 删除 → 增量重导入(同文件跳过/变更重索引)→ 注册表持久化重载。
 * 语义质量由 e2e(真模型)验证,这里只验机器。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZvecKbService } from '../lib/index.js'
import type { Embedder } from '../lib/index.js'
import { FakeEmbedder } from '../src/embedder.ts'

class StubTools extends Service {
  constructor(ctx: InstanceType<typeof Context>) { super(ctx, 'tools') }
  register(): void {}
}

class StubSystemPrompt extends Service {
  constructor(ctx: InstanceType<typeof Context>) { super(ctx, 'systemPrompt') }
  section(): void {}
}

class TestKbService extends ZvecKbService {
  protected createEmbedder(): Embedder {
    return new FakeEmbedder(8)
  }
}

let ctx: InstanceType<typeof Context>
let svc: TestKbService
let home: string
let docsDir: string

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'zveckb-'))
  process.env.DSH_ZVECKB_HOME = home
  docsDir = join(home, 'docs')
  await mkdir(join(docsDir, 'node_modules'), { recursive: true })
  await mkdir(join(docsDir, 'sub'), { recursive: true })
  await writeFile(join(docsDir, 'alpha.md'), '# 网络参数\n\n连接建立后,若对端在 30 秒内没有任何响应,会话将被主动中断并释放资源。阈值可在高级设置调整。\n\n# 其他\n\n无关内容,用于撑块数的一段文字,确保分块器工作正常。', 'utf8')
  await writeFile(join(docsDir, 'beta.txt'), '退款说明:商品签收后七日内可联系客服发起退货,款项三个工作日内原路退回。ZKW-42 是本文件独有的检索锚点。', 'utf8')
  await writeFile(join(docsDir, 'sub', 'gamma.md'), '权限制度:新入职员工由直属主管提交账号申请,经部门负责人审批后完成角色绑定。', 'utf8')
  await writeFile(join(docsDir, 'node_modules', 'skipped.txt'), '这里的内容不应被导入。', 'utf8')
  await writeFile(join(docsDir, 'x.bin'), '\u0000\u0001', 'utf8')

  ctx = new Context()
  await ctx.plugin(StubTools)
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(TestKbService)
  svc = ctx.zvecKb as TestKbService
})

afterAll(async () => {
  svc.shutdown()
  await rm(home, { recursive: true, force: true }).catch(() => {
    /* Windows 下 zvec LOCK 可能未即时释放,残留临时目录交给系统清理 */
  })
  delete process.env.DSH_ZVECKB_HOME
})

describe('dsh-zvec-kb 集成', () => {
  it('文件夹导入:支持格式入队,跳过目录与不支持扩展名', async () => {
    const r = await svc.importPath(docsDir)
    expect(r.ok).toBe(true)
    expect(r.queued).toBe(3)
    await svc.drain()
  })

  it('检索:关键词锚点带来源命中(beta#块号)', async () => {
    const r = await svc.search('ZKW-42', 5)
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('hybrid')
    expect(r.hits.length).toBeGreaterThan(0)
    const top = r.hits.map((h) => h.ref).join('\n')
    expect(top).toContain('beta.txt#0')
    const hit = r.hits.find((h) => h.ref.includes('beta.txt'))
    expect(hit?.text).toContain('ZKW-42')
  })

  it('中文分词 FTS:jieba 命中多字词', async () => {
    const r = await svc.search('原路退回', 5)
    expect(r.hits.some((h) => h.ref.includes('beta.txt'))).toBe(true)
  })

  it('列表与状态', async () => {
    const l = await svc.listFiles()
    expect(l.ok).toBe(true)
    expect(l.files.length).toBe(3)
    expect(l.files.every((f) => f.status === 'done')).toBe(true)
    const s = await svc.statusInfo()
    expect(s.ok).toBe(true)
    expect(s.files).toBe(3)
    expect(s.chunks).toBeGreaterThanOrEqual(3)
    expect(s.model).toBe('ready')
  })

  it('删除:按路径移除后检索不再命中', async () => {
    const r = await svc.remove(join(docsDir, 'beta.txt'))
    expect(r.ok).toBe(true)
    expect(r.removed).toBe(true)
    const after = await svc.search('ZKW-42', 5)
    expect(after.hits.some((h) => h.ref.includes('beta.txt'))).toBe(false)
  })

  it('增量:同内容重导入跳过,变更文件重索引', async () => {
    const first = await svc.importPath(docsDir)
    await svc.drain()
    expect(first.queued).toBeGreaterThan(0) // beta 刚被删,重新入队
    const second = await svc.importPath(docsDir)
    expect(second.queued).toBe(0)
    expect(second.skippedUnchanged).toBe(3)
    // 变更 alpha.md
    await writeFile(join(docsDir, 'alpha.md'), '# 网络参数\n\n新的内容:超时阈值改为 60 秒,依然保持会话中断逻辑,这段内容比以前短一些。', 'utf8')
    const third = await svc.importPath(docsDir)
    expect(third.queued).toBe(1)
    await svc.drain()
    const old = await svc.search('释放资源', 5)
    expect(old.hits.some((h) => h.ref.includes('alpha.md#') && h.text.includes('释放资源'))).toBe(false)
  })

  it('注册表持久化:新实例重载(zvec 写锁单进程独占,先释放旧实例)', async () => {
    await svc.drain()
    svc.shutdown()
    const ctx2 = new Context()
    await ctx2.plugin(StubTools)
    await ctx2.plugin(StubSystemPrompt)
    await ctx2.plugin(TestKbService)
    const svc2 = ctx2.zvecKb as TestKbService
    const l = await svc2.listFiles()
    expect(l.files.length).toBe(3)
    const r = await svc2.search('权限制度', 5)
    expect(r.hits.some((h) => h.ref.includes('gamma.md'))).toBe(true)
    svc2.shutdown()
  })

  it('不存在的路径报错', async () => {
    const r = await svc.importPath(join(home, 'nope'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('路径不存在')
  })
})
