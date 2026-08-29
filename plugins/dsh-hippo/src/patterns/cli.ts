/**
 * patterns 扫描 CLI —— 与 hippo `python -m hippo.cli patterns` 输出对齐，
 * 用于 TS 移植的真实数据对照验证。
 *
 * 用法：npx tsx src/patterns/cli.ts [--json] [--dir PATH] [--limit N]
 *        [--min-sessions N] [--min-count N] [--top N]
 */
import * as path from 'node:path';
import {
  findTranscripts,
  loadSessionEvents,
  minePatterns,
  patternToDict,
  renderPattern,
  scorePatterns,
  type ToolEvent,
} from './miner.js';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function argStr(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const files = findTranscripts(argStr('--dir'), argNum('--limit', 0));
if (!files.length) {
  console.log('no transcripts found. Pass --dir PATH or check ~/.claude/projects/.');
  process.exit(0);
}

const sessions = new Map<string, ToolEvent[]>();
for (const f of files) {
  const events = loadSessionEvents(f);
  if (events.length) sessions.set(path.basename(f, '.jsonl'), events);
}
if (!sessions.size) {
  console.log(`(no tool calls found in ${files.length} transcripts)`);
  process.exit(0);
}

const patterns = minePatterns(sessions, {
  minSessions: argNum('--min-sessions', 2),
  minCount: argNum('--min-count', 3),
});
const ranked = scorePatterns(patterns).slice(0, argNum('--top', 20));
console.log(
  `scanned ${sessions.size} sessions with tool calls ` +
  `(${files.length} transcripts), ${patterns.length} patterns survived filtering\n`,
);
if (!ranked.length) {
  console.log('(no recurring cross-session workflows)');
  process.exit(0);
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(ranked.map(patternToDict), null, 2));
} else {
  for (const p of ranked) console.log(renderPattern(p) + '\n');
}
