// Spike 门 1+2:本地 embedding 质量 + zvec 混合检索 vs 纯 FTS 命中率
import { env, pipeline } from '@huggingface/transformers';
import {
  ZVecCreateAndOpen, ZVecCollectionSchema, ZVecDataType, ZVecIndexType,
  ZVecGetDefaultJiebaDictDir,
} from '@zvec/zvec';
import { readFileSync, rmSync } from 'node:fs';

const t0 = performance.now();
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' });
console.log(`模型加载: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章:';
async function embed(texts, isQuery = false) {
  const out = [];
  for (const t of texts) {
    const r = await extractor(isQuery ? QUERY_PREFIX + t : t, { pooling: 'mean', normalize: true });
    out.push(Array.from(r.data));
  }
  return out;
}

// 语料:真实公开文档 + 3 个"换种说法"陷阱文档
const realFiles = [
  '../../plugins/dsh-opencli/README.md',
  '../../plugins/dsh-opencli/SKILL.md',
  '../../plugins/dsh-opencli/src/client.ts',
];
const docs = realFiles.map((f) => {
  try { return readFileSync(f, 'utf8').slice(0, 2500); } catch { return null; }
}).filter(Boolean).map((c, i) => ({ id: `real${i + 1}`, text: c }));

docs.push(
  { id: 'net', text: '网络参数设置:连接建立后,若对端在 30 秒内没有任何响应,会话将被主动中断并释放资源。该阈值可在高级设置的会话页签中调整,默认值建议保持不变。' },
  { id: 'refund', text: '售后服务说明:商品签收后七日内,如未影响二次销售,可联系客服发起退货,款项将在三个工作日内原路退回。定制类商品不支持无理由退货。' },
  { id: 'acl', text: '权限管理制度:新入职员工由直属主管在管理后台提交账号申请,经部门负责人审批后,由系统管理员完成角色绑定,全程无需线下单据。' },
  { id: 'deploy', text: '发布流程:代码合入主干后自动触发流水线,先跑单元测试,再构建镜像并推送到内部仓库,最后由值班同学确认灰度批次。' },
);

const t1 = performance.now();
const docVecs = await embed(docs.map((d) => d.text));
console.log(`文档向量化: ${docs.length} 篇 / ${((performance.now() - t1) / docs.length).toFixed(0)}ms 每篇`);

const schema = new ZVecCollectionSchema({
  name: 'spikekb',
  vectors: { name: 'emb', dataType: ZVecDataType.VECTOR_FP32, dimension: docVecs[0].length },
  fields: [{
    name: 'text', dataType: ZVecDataType.STRING,
    indexParams: { indexType: ZVecIndexType.FTS, tokenizer: 'jieba', jieba_dict_dir: ZVecGetDefaultJiebaDictDir() },
  }],
});
rmSync('./spike_db', { recursive: true, force: true });
const col = ZVecCreateAndOpen('./spike_db', schema);
col.insertSync(docs.map((d, i) => ({ id: d.id, vectors: { emb: docVecs[i] }, fields: { text: d.text } })));

// 查询集:每条都指向一个陷阱文档,且关键词几乎零重叠
const queries = [
  ['怎么配置超时时间', 'net'],
  ['买了东西想把钱要回来', 'refund'],
  ['新同事要开系统账号找谁', 'acl'],
  ['代码怎么上线', 'deploy'],
  ['命令行工具怎么装', 'real1'], // opencli README 里应有安装说明
  ['中文分词的效果怎么样', 'net'], // 干扰项:不该命中 net
];

const fmt = (r) => r.map((x) => `${x.id}(${x.score?.toFixed?.(3) ?? '?'})`).join(' ');
let ftsHit = 0, vecHit = 0, hybHit = 0;
for (const [q, want] of queries) {
  const qv = (await embed([q], true))[0];
  const tq = performance.now();
  const fts = col.querySync({ fieldName: 'text', fts: { queryString: q }, topk: 3 });
  const vec = col.querySync({ fieldName: 'emb', vector: qv, topk: 3 });
  const hyb = col.multiQuerySync({
    queries: [
      { fieldName: 'emb', vector: qv, topk: 3 },
      { fieldName: 'text', fts: { queryString: q }, topk: 3 },
    ],
    topk: 3,
  });
  const ms = (performance.now() - tq).toFixed(0);
  if (fts[0]?.id === want) ftsHit++;
  if (vec[0]?.id === want) vecHit++;
  if (hyb[0]?.id === want) hybHit++;
  console.log(`\nQ: ${q}  (期望 ${want})  三路耗时 ${ms}ms`);
  console.log(`  FTS : ${fmt(fts)}`);
  console.log(`  VEC : ${fmt(vec)}`);
  console.log(`  HYB : ${fmt(hyb)}`);
}
col.closeSync();
console.log(`\n=== 命中率@1: FTS ${ftsHit}/${queries.length} | VEC ${vecHit}/${queries.length} | HYBRID ${hybHit}/${queries.length} ===`);
