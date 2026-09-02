/**
 * zvec 存储层:一个 collection(kbchunks),emb 向量字段 + text(jieba FTS)+ file/chunk 标量字段。
 * 进程内、WAL 持久化;写单进程独占(本服务即唯一写者)。
 * 结果只含 fileId+chunkIdx,来源路径由服务层查注册表还原。
 * @module dsh-zvec-kb
 */

import { ZVecCreateAndOpen, ZVecOpen, ZVecCollectionSchema, ZVecDataType, ZVecIndexType, ZVecGetDefaultJiebaDictDir } from '@zvec/zvec'
import type { ZVecCollection } from '@zvec/zvec'
import type { SearchHit } from './types.ts'

/** 原始行:store 视角(fileId + 块号),还没有路径。 */
export interface RawHit {
  file: string
  chunk: number
  score: number
  text: string
}

export class KbStore {
  private col: ZVecCollection | null = null
  private openError: string | null = null

  constructor(
    private readonly dir: string,
    private readonly dim: number,
  ) {}

  /** 打开(或首次创建)collection;失败记录错误,后续调用返回空结果而不是抛。 */
  open(): void {
    const schema = new ZVecCollectionSchema({
      name: 'kbchunks',
      vectors: { name: 'emb', dataType: ZVecDataType.VECTOR_FP32, dimension: this.dim },
      fields: [
        {
          name: 'text',
          dataType: ZVecDataType.STRING,
          indexParams: {
            indexType: ZVecIndexType.FTS,
            tokenizerName: 'jieba',
            extraParams: JSON.stringify({ jieba_dict_dir: ZVecGetDefaultJiebaDictDir() }),
          },
        },
        { name: 'file', dataType: ZVecDataType.STRING },
        { name: 'chunk', dataType: ZVecDataType.INT64 },
      ],
    })
    try {
      this.col = ZVecCreateAndOpen(this.dir, schema)
    } catch {
      try {
        this.col = ZVecOpen(this.dir)
      } catch (err: unknown) {
        this.openError = err instanceof Error ? err.message : String(err)
        this.col = null
      }
    }
  }

  get error(): string | null {
    return this.openError
  }

  get ok(): boolean {
    return this.col !== null
  }

  insert(fileId: string, texts: string[], vectors: number[][]): void {
    if (this.col === null) throw new Error(this.openError ?? 'store 未打开')
    this.col.insertSync(
      texts.map((text, i) => ({
        // zvec 文档 id 不允许 ':',用 '#' 分隔
        id: `${fileId}#${i}`,
        vectors: { emb: vectors[i] },
        fields: { text, file: fileId, chunk: i },
      })) as never,
    )
  }

  deleteFile(fileId: string): void {
    if (this.col === null) throw new Error(this.openError ?? 'store 未打开')
    this.col.deleteByFilterSync(`file == "${fileId}"`)
  }

  /**
   * 手动 RRF 混合检索:向量腿 + FTS 腿各自取 topk*2,按排名融合(0.75/0.25)。
   * 不用 zvec weighted 融合——余弦(0.7~0.9)与 BM25 原始分(1~15)尺度悬殊,
   * 直接加权会让 FTS 的弱词法匹配压过向量排序(真模型 E2E 实证);RRF 只看排名,天然免疫尺度差。
   */
  search(queryVec: number[] | null, query: string, topk: number): RawHit[] {
    if (this.col === null) return []
    const mapRow = (r: { score: number; fields: { text?: string; file?: string; chunk?: number } }): RawHit => ({
      file: String(r.fields.file ?? ''),
      chunk: Number(r.fields.chunk ?? 0),
      score: Number(r.score ?? 0),
      text: String(r.fields.text ?? ''),
    })
    const fetch = Math.max(topk * 2, 10)
    const vecRows = queryVec === null
      ? []
      : (this.col.querySync({ fieldName: 'emb', vector: queryVec, topk: fetch } as never) as unknown[] as { score: number; fields: { text?: string; file?: string; chunk?: number } }[]).map(mapRow)
    let ftsRows: RawHit[] = []
    try {
      ftsRows = (this.col.querySync({ fieldName: 'text', fts: { queryString: query }, topk: fetch } as never) as unknown[] as { score: number; fields: { text?: string; file?: string; chunk?: number } }[]).map(mapRow)
    } catch {
      /* FTS 语法异常不阻断向量腿 */
    }

    const W_VEC = 0.75
    const W_FTS = 0.25
    const K = 60
    const merged = new Map<string, { hit: RawHit; rrf: number }>()
    const add = (rows: RawHit[], w: number): void => {
      rows.forEach((r, i) => {
        const key = `${r.file}#${r.chunk}`
        const cur = merged.get(key)
        const contrib = w / (K + i + 1)
        if (cur === undefined) merged.set(key, { hit: r, rrf: contrib })
        else cur.rrf += contrib
      })
    }
    add(vecRows, W_VEC)
    add(ftsRows, W_FTS)
    return [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, topk).map((m) => ({ ...m.hit, score: m.rrf }))
  }

  close(): void {
    if (this.col !== null) {
      try {
        this.col.closeSync()
      } catch {
        /* 关闭失败不影响进程退出 */
      }
      this.col = null
    }
  }
}
