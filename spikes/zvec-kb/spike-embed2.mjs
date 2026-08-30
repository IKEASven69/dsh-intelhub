// Spike 修正版:按段落/标题分块后再对比。分块是真实插件的标配行为。
import { pipeline } from '@huggingface/transformers';
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

// 分块:优先在空行/标题处断,块长 ~120-400 字
function chunk(text, source, maxLen = 400) {
  const paras = text.split(/\n(?=#{1,4} |\*\*|[-*] |\d+\.|$)/).flatMap((p) => p.split(/\n\s*\n/));
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    const s = p.trim();
    if (!s) continue;
    if (buf.length + s.length <= maxLen) { buf += (buf ? '\n' : '') + s; }
    else {
      if (buf) chunks.push(buf);
      if (s.length <= maxLen) buf = s;
      else { for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen)); buf = ''; }
    }
  }
  if (buf) chunks.push(buf);
  return chunks.map((c, i) => ({ id: `${source}#${i}`, text: c }));
}

const realFiles = [
  ['opencli-readme', '../../plugins/dsh-opencli/README.md'],
  ['opencli-skill', '../../plugins/dsh-opencli/SKILL.md'],
];
const docs = realFiles.flatMap(([name, f]) => {
  try { return chunk(readFileSync(f, 'utf8'), name); } catch { return []; }
});
docs.push(
  { id: 'net#0', text: '网络参数设置:连接建立后,若对端在 30 秒内没有任何响应,会话将被主动中断并释放资源。该阈值可在高级设置的会话页签中调整,默认值建议保持不变。' },
  { id: 'refund#0', text: '售后服务说明:商品签收后七日内,如未影响二次销售,可联系客服发起退货,款项将在三个工作日内原路退回。定制类商品不支持无理由退货。' },
  { id: 'acl#0', text: '权限管理制度:新入职员工由直属主管在管理后台提交账号申请,经部门负责人审批后,由系统管理员完成角色绑定,全程无需线下单据。' },
  { id: 'deploy#0', text: '发布流程:代码合入主干后自动触发流水线,先跑单元测试,再构建镜像并推送到内部仓库,最后由值班同学确认灰度批次。' },
);
console.log(`语料: ${docs.length} 个分块`);

const t1 = performance.now();
const vecs = await embed(docs.map((d) => d.text));
console.log(`向量化: ${((performance.now() - t1) / docs.length).toFixed(0)}ms 每块`);

const schema = new ZVecCollectionSchema({
  name: 'spikekb2',
  vectors: { name: 'emb', dataType: ZVecDataType.VECTOR_FP32, dimension: vecs[0].length },
  fields: [{
    name: 'text', dataType: ZVecDataType.STRING,
    indexParams: { indexType: ZVecIndexType.FTS, tokenizer: 'jieba', jieba_dict_dir: ZVecGetDefaultJiebaDictDir() },
  }],
});
rmSync('./spike_db2', { recursive: true, force: true });
const col = ZVecCreateAndOpen('./spike_db2', schema);
col.insertSync(docs.map((d, i) => ({ id: d.id, vectors: { emb: vecs[i] }, fields: { text: d.text } })));

const queries = [
  ['怎么配置超时时间', 'net'],
  ['买了东西想把钱要回来', 'refund'],
  ['新同事要开系统账号找谁', 'acl'],
  ['代码怎么上线', 'deploy'],
  ['这个插件能帮我干什么', 'opencli-readme'],
  ['适配器怎么安装', 'opencli-skill'],
];

const fmt = (r) => r.map((x) => `${x.id}(${(x.score ?? 0).toFixed(3)})`).join(' ');
const hit = { fts: [0, 0], vec: [0, 0], hyb: [0, 0] }; // [hit@1, hit@3]
for (const [q, want] of queries) {
  const qv = (await embed([q], true))[0];
  const fts = col.querySync({ fieldName: 'text', fts: { queryString: q }, topk: 3 });
  const vec = col.querySync({ fieldName: 'emb', vector: qv, topk: 3 });
  const hyb = col.multiQuerySync({
    queries: [
      { fieldName: 'emb', vector: qv, topk: 3 },
      { fieldName: 'text', fts: { queryString: q }, topk: 3 },
    ],
    topk: 3,
  });
  for (const [k, r] of [['fts', fts], ['vec', vec], ['hyb', hyb]]) {
    if (r[0]?.id?.split('#')[0] === want) hit[k][0]++;
    if (r.some((x) => x.id?.split('#')[0] === want)) hit[k][1]++;
  }
  console.log(`\nQ: ${q}  (期望 ${want}#*)`);
  console.log(`  FTS : ${fmt(fts)}`);
  console.log(`  VEC : ${fmt(vec)}`);
  console.log(`  HYB : ${fmt(hyb)}`);
}
col.closeSync();
console.log(`\n=== 命中@1 / 命中@3 ===`);
console.log(`FTS   : ${hit.fts[0]}/6 | ${hit.fts[1]}/6`);
console.log(`VEC   : ${hit.vec[0]}/6 | ${hit.vec[1]}/6`);
console.log(`HYBRID: ${hit.hyb[0]}/6 | ${hit.hyb[1]}/6`);
