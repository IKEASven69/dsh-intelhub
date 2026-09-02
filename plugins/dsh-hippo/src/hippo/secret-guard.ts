/**
 * 敏感信息闸门（H9-①）：记忆入库前的 secret 检测。
 *
 * 风险链路：会话里贴过的 .env / API key / 密码会被蒸馏成记忆 → 明文进
 * memoryfield 镜像 → 进 AGENTS.md → 可能进 git/网盘。闸门放在写入端，
 * 任何路径（distill / MCP remember / CLI / import 回流）都拦得住。
 *
 * 设计取舍：
 * - 高置信模式才拦（真 key 形态），宁漏勿误——误杀正常技术讨论比漏掉
 *   一个低价值 key 代价高
 * - remember() 对命中返回 status='rejected'（不抛错），调用方按需提示；
 *   distill 管线把 rejected 计入 skipped
 * - 存量扫描复用同一模式表（hippo secrets）
 */

export interface SecretHit { kind: string; preview: string }

/** 模式表：kind 为人类可读的类别名。全部要求高置信形态。 */
const PATTERNS: Array<{ re: RegExp; kind: string }> = [
  // OpenAI / MiniMax / Anthropic 等兼容形态的 key
  { re: /\bsk-(?:ant-|cp-|proj-)?[A-Za-z0-9_-]{16,}\b/g, kind: 'API key (sk-…)' },
  // AWS Access Key ID
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: 'AWS AccessKey' },
  // GitHub / Slack tokens
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, kind: 'GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, kind: 'Slack token' },
  // JWT（三段式，前两段足够长避免误伤普通 base64 词）
  { re: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}/g, kind: 'JWT' },
  // 私钥块
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, kind: '私钥块' },
  // Bearer 调用头
  { re: /\bBearer\s+[A-Za-z0-9_\-./=]{20,}/g, kind: 'Bearer token' },
  // 带凭证的数据库连接串
  { re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:]+:[^\s]+@[a-z0-9]/gi, kind: '数据库连接串(含密码)' },
  // 键值形态的明文密钥（key/secret/token/password 后跟长值）
  { re: /\b(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|password|passwd|pwd|client[_-]?secret|private[_-]?key)["']?\s*[=:\:\uFF1A\s]*["']?[^\s"']{10,}["']?/gi, kind: '键值明文密钥' },
];

/** 扫描文本，返回全部命中（去重后）。 */
export function findSecrets(text: string): SecretHit[] {
  if (!text || text.length < 12) return [];
  const hits: SecretHit[] = [];
  const seen = new Set<string>();
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const raw = m[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      // 预览脱敏：只留前 6 后 2，中间打码
      const preview = raw.length > 12
        ? `${raw.slice(0, 6)}…${raw.slice(-2)}`
        : raw.slice(0, 4) + '…';
      hits.push({ kind, preview });
    }
  }
  return hits;
}

/** 便捷判定：是否含疑似密钥。 */
export function hasSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}
