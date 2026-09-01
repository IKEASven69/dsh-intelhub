/**
 * Distill durable memories from AI coding-agent session transcripts.
 * TS port of hippo distill.py (rules + dedup bands); transcript parsing is
 * the spike's src/patterns/transcript.ts and is reused, not duplicated.
 *
 * Local-first, zero API keys: rule/heuristic extraction (no LLM). Coding-agent
 * transcripts carry highly explicit signal ("决定用 X", "根因是 Y", "以后都 Z")
 * that rules capture well enough. A `refiner` hook is left for future optional
 * LLM polishing, but nothing here bundles a provider client.
 *
 * Pipeline: transcript JSONL -> parse -> Turn list -> rule extraction ->
 *           Candidate list -> dedup vs existing store -> apply (remember) or
 *           dry-run (preview).
 */
import { cwdToProject, type Turn } from '../patterns/transcript.js';
import { saveSource } from './sources.js';
import { DEDUP_THRESHOLD, GLOBAL_PROJECT, type MemoryEngine } from './memory.js';

// ---------------------------------------------------------------------------
// Dedup bands. The "maybe" band between the two thresholds is the key
// quality control for distillation: near-duplicates below the hard dedup
// threshold but clearly the same topic are surfaced for review instead of
// being silently created (which would pollute recall). Recalibrated for
// bge-m3 — see docs/threshold-calibration.md.
// ---------------------------------------------------------------------------
export const DEDUP_REINFORCE = DEDUP_THRESHOLD; // >= : same memory, reinforce
export const DEDUP_MAYBE = 0.8; // >= and < REINFORCE: likely duplicate, do not auto-merge
// 推翻带：同主题且双方都是 decision 时视为"改主意"而非重复——新版取代旧版（双时态演化链）。
// 0.85 起（zvec 相似度整体膨胀，0.7 会把"相邻主题"误判成改主意——CI 平台选择
// 曾误取代测试运行器选择）；且候选文本须带翻转语言证据（改用/弃用/不再用…），
// 单纯高相似的另一个决定不构成推翻。
export const SUPERSEDE_FLOOR = 0.85;
export const FLIP_PATTERN = /(改用|换成|换用|弃用|不再用|放弃|推翻之前|改为|switch(?:ed)? to|instead of|replaced? by|no longer)/i;
export const MAX_CANDIDATES = 20; // per transcript, to cap noise

// ---------------------------------------------------------------------------
// Rule-based extraction.
// ---------------------------------------------------------------------------

interface Rule {
  type: string;
  pattern: RegExp;
  confidence: number;
}

// Each rule: (memory_type, regex, confidence). Patterns match Chinese and
// English phrasings observed in real coding-agent transcripts. A match
// extracts the *sentence* containing the trigger (not the whole turn) so
// candidates stay concise and self-contained.
export const RULES: Rule[] = [
  // --- preference: durable instructions about how to behave ---
  { type: 'preference', pattern: /(以后都|总是要|默认要|记得要|偏好|喜欢|讨厌|务必|prefer|always|never|by default|from now on)/i, confidence: 0.7 },
  // --- decision: explicit choices of approach / tech / direction ---
  { type: 'decision', pattern: /(决定|采用|改用|方案[是确定就]|就[用选]|定下来|我们选|chose|decided to|let'?s go with|use \S+ instead of|switch(?:ed)? to|went with)/i, confidence: 0.7 },
  // --- lesson: root causes, gotchas, workarounds discovered ---
  { type: 'lesson', pattern: /(根因是|原因是|发现原因|踩坑|原来|坑|workaround|turns out|gotcha|lesson learned|failed because|the problem was|misconception|不严谨|之前[说的想]错了)/i, confidence: 0.7 },
  // --- fact: concrete technical specifics (ports, paths, stack, config) ---
  { type: 'fact', pattern: /(端口是|入口是|数据[在存]|技术栈|配置[在是]|默认[是端口]|stored in|located at|the config is|listens? on port|entry point)/i, confidence: 0.65 },
];

// Explicit "remember this" triggers raise confidence on whatever sentence
// they appear in (the sentence is captured regardless of which rule matched).
const REMEMBER_TRIGGER = /(记住|记下来|记一下|别忘了|重要|remember this|note this|keep in mind|don'?t forget)/i;

// Pronouns / deictics at the start of a candidate that make it non-self-contained.
const LEADING_PRONOUN = /^\s*(它|这[个是条]|那个|那[是条]|this|that|it|these|those)\s*/i;

// ---------------------------------------------------------------------------
// 质量闸门：规则匹配只看触发词，而 agent 转写里大量"过程自语"同样含触发词
// （"我需要决定端口号"、"Let me confirm"、"## 几个设计岔路"）。这些句子
// 对未来会话毫无价值，进库只会污染召回。以下模式是抽查真实库后标定的
// 高置信噪音特征——宁可漏掉少量边界样本，不误伤干净短句（如"决定用 X。"）。
// ---------------------------------------------------------------------------
const NOISE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  // 过程自语：模型描述自己正在做什么（中英）
  { re: /^(让我|我来|我先|我需要|我要|我得|我之前|我刚才|我也|我想|我觉得|接下来|wait[,. ]|let me|let'?s|i need|i have|i should|i'?ll|i'?m going to|now let|so let|so[, ]|first[, ]|second[, ]|finally[, ]|continue)/i, why: 'monologue' },
  // markdown 标题行：只有标题没有内容
  { re: /^#{1,6}\s/, why: 'heading' },
  // 疑问句：问题是待办不是结论
  { re: /[?？]\s*$/, why: 'question' },
  // 编号清单碎片："2. [pending] …" / "9. 决定 xxx"（列表项而非陈述）
  { re: /^\d+[.)][\s\[]/, why: 'list-fragment' },
  // 环境注入样板（WorkBuddy/部分宿主把人设与规则注入 user 轮）
  { re: /^(you are (a|an)\b|note: prefer|as an? (expert|assistant)|i want you to act)/i, why: 'persona-boilerplate' },
  // 系统提示词泄漏："Continue the conversation…" 被截进偏好
  { re: /continue the conversation from where it left off|without asking (the )?user/i, why: 'instruction-leak' },
];

/** 候选是否为高置信噪音（过程自语/标题/疑问/清单碎片/提示词泄漏）。 */
export function isNoiseCandidate(text: string): boolean {
  const t = text.trim();
  return NOISE_PATTERNS.some(({ re }) => re.test(t));
}

// Sentence splitter that works for Chinese and English: 。！？.!?\n
const SENTENCE_END = /[。！？!?\n]+/;

function splitSentences(text: string): string[] {
  return text.split(SENTENCE_END).map(p => p.trim()).filter(p => p);
}

function recentReferent(turns: Turn[], idx: number): string {
  // Best-effort referent for pronoun resolution: the most recent tool's
  // file path / command. Returns '' if none.
  for (let j = idx - 1; j >= 0; j--) {
    const t = turns[j];
    if (t.toolName) {
      const m = /[\w./\\-]+\.\w+/.exec(t.text); // a file path
      if (m) return m[0];
      return t.toolName;
    }
  }
  return '';
}

/** A distilled memory candidate, before dedup/apply. */
export interface Candidate {
  text: string;
  type: string; // fact | decision | lesson | preference
  project: string;
  confidence: number;
  source_rule: string; // which pattern matched, for debugging/provenance
  duplicate: '' | 'new' | 'reinforce' | 'maybe' | 'supersede'; // filled by distill()
  similarity: number; // to the closest existing memory, filled by distill()
  source_offset: number; // turn index this came from (L1→L0 provenance)
  source_id: string; // filled by distill() when an L0 blob is saved
}

export function makeCandidate(init: Partial<Candidate> & Pick<Candidate, 'text' | 'type' | 'project' | 'confidence' | 'source_rule'>): Candidate {
  return { duplicate: '', similarity: 0.0, source_offset: -1, source_id: '', ...init };
}

export function candidateToDict(c: Candidate): Record<string, unknown> {
  return {
    text: c.text,
    type: c.type,
    project: c.project,
    confidence: c.confidence,
    source_rule: c.source_rule,
    duplicate: c.duplicate,
    similarity: c.similarity,
    source_offset: c.source_offset,
    source_id: c.source_id,
  };
}

export function extractCandidates(
  turns: Turn[],
  opts: {
    projectOverride?: string;
    refiner?: (candidates: Candidate[]) => Candidate[];
  } = {},
): Candidate[] {
  const { projectOverride, refiner } = opts;
  const seenTexts = new Set<string>();
  let candidates: Candidate[] = [];

  for (let idx = 0; idx < turns.length; idx++) {
    const turn = turns[idx];
    // Only extract from substantive user instructions and assistant text.
    // Tool turns (command output) are noise unless they're a failure (lesson).
    if (turn.role !== 'user' && turn.role !== 'assistant') {
      if (turn.toolFailed) {
        const text = `操作失败: ${turn.text.slice(0, 200)}`;
        if (!seenTexts.has(text)) {
          seenTexts.add(text);
          candidates.push(makeCandidate({
            text, type: 'lesson',
            project: projectOverride ?? cwdToProject(turn.cwd),
            confidence: 0.6, source_rule: 'tool_failed',
            source_offset: idx,
          }));
        }
      }
      continue;
    }

    const project = projectOverride ?? cwdToProject(turn.cwd);
    const referent = recentReferent(turns, idx);
    const boosted = REMEMBER_TRIGGER.test(turn.text);

    for (const sentence of splitSentences(turn.text)) {
      for (const rule of RULES) {
        if (!rule.pattern.test(sentence)) continue;
        let text = sentence.trim();
        // Pronoun cleanup: replace a leading "it/这个" with the referent.
        if (LEADING_PRONOUN.test(text) && referent) {
          text = text.replace(LEADING_PRONOUN, referent + ' ');
        }
        // 质量闸门：拒收过程自语/标题/疑问/清单碎片（见 NOISE_PATTERNS 注释）。
        if (isNoiseCandidate(text)) break;
        // Truncate very long sentences; they're rarely good memories.
        if (text.length > 300) text = text.slice(0, 297) + '…';
        const key = text.toLowerCase();
        if (seenTexts.has(key)) break;
        seenTexts.add(key);
        const confidence = Math.min(1.0, rule.confidence + (boosted ? 0.25 : 0.0));
        candidates.push(makeCandidate({
          text, type: rule.type, project,
          confidence, source_rule: rule.type,
          source_offset: idx,
        }));
        break; // one type per sentence; first matching rule wins
      }
    }
  }

  // Cap noise: keep the top-N most confident.
  candidates.sort((a, b) => b.confidence - a.confidence);
  candidates = candidates.slice(0, MAX_CANDIDATES);

  return refiner ? refiner(candidates) : candidates;
}

// ---------------------------------------------------------------------------
// Dedup against the store + apply.
// ---------------------------------------------------------------------------

export interface DistillResult {
  created: number;
  reinforced: number;
  skipped: number;
  maybe: number; // candidates in the maybe band (not applied)
  candidates: Candidate[];
}

export async function distill(
  engine: MemoryEngine,
  candidates: Candidate[],
  opts: {
    apply?: boolean;
    agent?: string;
    turns?: Turn[];
    dataDir?: string;
    /** 外部预存的 L0 source id（auto-distill 先存源再分流，避免二次落盘） */
    sourceId?: string;
    /** LLM 精炼（可选）：去重判决前过滤/改写候选——规则管召回、LLM 管精度。
     *  传 null/不传 = 纯规则；LLM 不可用时 llmRefine 内部降级原样返回。 */
    refiner?: (candidates: Candidate[]) => Promise<Candidate[]>;
  } = {},
): Promise<DistillResult> {
  const { apply = false, agent = 'distill:claude', turns, dataDir, refiner } = opts;

  // Save one L0 blob for the whole transcript; every candidate references it.
  let sourceId = opts.sourceId ?? '';
  if (!sourceId && turns && turns.length && candidates.some(c => c.source_offset >= 0)) {
    const proj = candidates.length ? candidates[0].project : '';
    sourceId = saveSource(turns.map(turnToDict), { project: proj, agent, dataDir });
  }

  // LLM 精炼在去重判决之前：被丢弃的候选不消耗嵌入计算，改写后的文本
  // 参与正常的 dedup/supersede 判定（改写不绕过任何质量带）。
  if (refiner && candidates.length > 0) {
    candidates = await refiner(candidates);
  }

  const result: DistillResult = { created: 0, reinforced: 0, skipped: 0, maybe: 0, candidates };
  for (const cand of candidates) {
    const vec = await engine.embedder(cand.text);
    const projects = cand.project === GLOBAL_PROJECT ? [cand.project] : [cand.project, GLOBAL_PROJECT];
    const hits = await engine.store.search(vec, projects, 1);
    const sim = hits.length ? hits[0][1] : 0.0;
    cand.similarity = Math.round(sim * 10000) / 10000;
    if (sourceId && !cand.source_id) cand.source_id = sourceId; // 保留候选自带值（task 回流按任务溯源）

    const hitRecord = hits.length ? hits[0][0] : null;
    const isDecisionFlip =
      sim >= SUPERSEDE_FLOOR && sim < DEDUP_REINFORCE
      && cand.type === 'decision' && hitRecord?.type === 'decision'
      && hitRecord.project === cand.project // 同项目才判定推翻——否则新项目决定会误伤 global 旧记忆
      && FLIP_PATTERN.test(cand.text); // 语言证据：真"改主意"的陈述几乎必带翻转词
    cand.duplicate = sim >= DEDUP_REINFORCE ? 'reinforce'
      : isDecisionFlip ? 'supersede'
      : sim >= DEDUP_MAYBE ? 'maybe' : 'new';

    if (!apply) continue;
    if (cand.duplicate === 'maybe') {
      result.maybe += 1;
      continue; // never auto-merge the uncertain band
    }
    try {
      const r = await engine.remember(cand.text, {
        type: cand.type, project: cand.project, agent,
        sourceId: cand.source_id || sourceId, // 候选自带溯源优先（task 回流按任务落 L0）
        sourceOffset: cand.source_offset >= 0 ? cand.source_offset : undefined,
      });
      if (r.status === 'created') result.created += 1;
      else if (r.status === 'reinforced') result.reinforced += 1;
      else result.skipped += 1;
      // 推翻链：新版创建成功后标记旧版被取代（reinforce 说明是同一条，不动）
      if (cand.duplicate === 'supersede' && r.status === 'created' && hitRecord) {
        await engine.markSuperseded(hitRecord.id, r.id);
      }
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}

function turnToDict(t: Turn): Record<string, unknown> {
  return {
    role: t.role, text: t.text, cwd: t.cwd, ts: t.ts,
    tool_name: t.toolName, tool_failed: t.toolFailed, model: t.model,
  };
}
