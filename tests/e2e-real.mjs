// 真模型 E2E(手动脚本,非 vitest):真 e5-small + 真文档文件夹 + spike 陷阱查询。
// 运行:node tests/e2e-real.mjs  (模型已缓存则秒级,否则首次下载约 30MB)
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const home = await mkdtemp(join(tmpdir(), 'zveckb-e2e-'))
process.env.DSH_INTELHUB_HOME = home

// 复用 spike 已下载的模型缓存,避免重复下载
const spikeCache = 'D:/CodingProjects/dsh-plugin/spikes/zvec-kb/node_modules/@huggingface/transformers/.cache'
if (existsSync(spikeCache)) {
  await mkdir(join(home, 'hf-cache'), { recursive: true })
  await cp(spikeCache, join(home, 'hf-cache'), { recursive: true })
}

const docs = join(home, 'docs')
await mkdir(join(docs, 'sub'), { recursive: true })
// 真文档:opencli 插件的公开文档
const real = [
  ['opencli-readme.md', 'D:/CodingProjects/dsh-plugin/plugins/dsh-opencli/README.md'],
  ['opencli-skill.md', 'D:/CodingProjects/dsh-plugin/plugins/dsh-opencli/SKILL.md'],
]
for (const [name, src] of real) {
  const { readFile } = await import('node:fs/promises')
  await writeFile(join(docs, name), await readFile(src, 'utf8'), 'utf8')
}
// 陷阱文档:关键词零重叠
const traps = {
  'net.md': '# 网络参数设置\n\n连接建立后,若对端在 30 秒内没有任何响应,会话将被主动中断并释放资源。该阈值可在高级设置的会话页签中调整,默认值建议保持不变。\n\n## 补充说明\n\n长时间运行的会话建议定期检查网络质量,避免因链路抖动造成误判。',
  'sub/refund.md': '# 售后服务说明\n\n商品签收后七日内,如未影响二次销售,可联系客服发起退货,款项将在三个工作日内原路退回。定制类商品不支持无理由退货。\n\n## 特殊情形\n\n大促期间的订单,退款时效可能顺延两个工作日。',
  'sub/acl.md': '# 权限管理制度\n\n新入职员工由直属主管在管理后台提交账号申请,经部门负责人审批后,由系统管理员完成角色绑定,全程无需线下单据。\n\n## 审计要求\n\n所有权限变更留痕五年,供季度审计抽查。',
  'deploy.md': '# 发布流程\n\n代码合入主干后自动触发流水线,先跑单元测试,再构建镜像并推送到内部仓库,最后由值班同学确认灰度批次。\n\n## 回滚\n\n线上异常时一键回滚到上一个稳定版本,十分钟内完成。',
}
for (const [name, content] of Object.entries(traps)) {
  await writeFile(join(docs, name), content, 'utf8')
}

const { ZvecKbService } = await import('../lib/index.js')
const { Context, Service } = await import('@deepseek-ai/cordis')
class StubTools extends Service { constructor(c) { super(c, 'tools') } register() {} }
class StubPrompt extends Service { constructor(c) { super(c, 'systemPrompt') } section() {} }

const ctx = new Context()
await ctx.plugin(StubTools)
await ctx.plugin(StubPrompt)
await ctx.plugin(ZvecKbService)
const svc = ctx.intelhub

const t0 = performance.now()
const imp = await svc.importPath(docs)
console.log(`导入: queued=${imp.queued} skipped=${imp.skippedUnchanged} (${((performance.now() - t0) / 1000).toFixed(1)}s 含模型加载)`)
await svc.drain()
const list = await svc.listFiles()
console.log('文件状态:', list.files.map((f) => `${f.path.split(/[\\/]/).pop()}=${f.status}(${f.chunks}块${f.error ? ':' + f.error : ''})`).join(' | '))

const queries = [
  ['怎么配置超时时间', 'net'],
  ['买了东西想把钱要回来', 'refund'],
  ['新同事要开系统账号找谁', 'acl'],
  ['代码怎么上线', 'deploy'],
  ['这个插件能帮我干什么', 'opencli-readme'],
  ['适配器怎么安装', 'opencli-skill'],
  ['线上出问题怎么恢复', 'deploy'], // 陷阱:关键词"恢复"↔"回滚"
]
let hit1 = 0
let hit3 = 0
for (const [q, want] of queries) {
  const r = await svc.search(q, 3)
  const top3 = r.hits.map((h) => `${h.ref.split(/[\\/]/).pop()}#${h.ref.split('#')[1]}(${h.score.toFixed(3)})`)
  const inTop1 = r.hits[0]?.ref.includes(`${want}.md`)
  const inTop3 = r.hits.some((h) => h.ref.includes(`${want}.md`))
  if (inTop1) hit1++
  if (inTop3) hit3++
  console.log(`Q: ${q} → ${inTop1 ? '✓' : inTop3 ? '△' : '✗'} [${r.mode}] ${top3.join(' ')}`)
}
console.log(`\n=== 真模型命中@1 ${hit1}/${queries.length} | 命中@3 ${hit3}/${queries.length} ===`)
svc.shutdown()
console.log('E2E done, home =', home)
