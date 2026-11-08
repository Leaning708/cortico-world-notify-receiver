import type { NotifyReceiverConfigSection } from './config.ts';

export interface ReplyMatch {
  matched: boolean;
  /** 去掉关键字后的转发正文。 */
  text: string;
  /** 命中的原始关键字。 */
  keyword?: string;
}

/** 逗号、中文逗号、换行、分号分隔的关键字列表。 */
export function parseKeywords(input: string): string[] {
  return String(input ?? '')
    .split(/[\n,，;；]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

const LEADING_PUNCTUATION = /^[\s:：,，、\-–—]+/;

function stripLeading(text: string): string {
  return text.replace(LEADING_PUNCTUATION, '').trim();
}

/**
 * 判断一条用户消息是否算“给 DSH 的回复”：只按关键字匹配，固定不区分大小写。
 * 关键字留空时任何消息都不命中（等价于关闭回传）。
 * stripKeyword 打开时，转发正文会去掉命中的关键字和紧跟的冒号/逗号。
 */
export function matchReplyText(text: string, policy: NotifyReceiverConfigSection): ReplyMatch {
  const source = String(text ?? '').trim();
  if (!source) return { matched: false, text: '' };

  const keywords = parseKeywords(policy.replyKeywords);
  if (keywords.length === 0) return { matched: false, text: '' };
  const normalizedSource = source.toLocaleLowerCase();

  for (const keyword of keywords) {
    const normalizedKeyword = keyword.toLocaleLowerCase();
    const matchMode = policy.replyKeywordMatch ?? 'prefix';

    if (matchMode === 'prefix') {
      if (!normalizedSource.startsWith(normalizedKeyword)) continue;
      const rest = source.slice(keyword.length);
      const body = policy.stripKeyword ? stripLeading(rest) : source;
      if (!body) continue;
      return { matched: true, text: body, keyword };
    }

    if (matchMode === 'contains') {
      const index = normalizedSource.indexOf(normalizedKeyword);
      if (index < 0) continue;
      const body = policy.stripKeyword
        ? stripLeading(source.slice(0, index) + source.slice(index + keyword.length))
        : source;
      if (!body) continue;
      return { matched: true, text: body, keyword };
    }

    if (matchMode === 'regex') {
      let regex;
      try {
        regex = new RegExp(keyword, 'i');
      } catch {
        continue;
      }
      const hit = source.match(regex);
      if (!hit || hit.index === undefined) continue;
      const body = policy.stripKeyword
        ? stripLeading(source.slice(0, hit.index) + source.slice(hit.index + hit[0].length))
        : source;
      if (!body) continue;
      return { matched: true, text: body, keyword };
    }
  }
  return { matched: false, text: '' };
}

function keywordPhrase(policy: NotifyReceiverConfigSection): string {
  const keywords = parseKeywords(policy.replyKeywords);
  const listed = keywords.slice(0, 5).map((keyword) => `「${keyword}」`).join('或');
  const more = keywords.length > 5 ? '等' : '';
  if (policy.replyKeywordMatch === 'contains') return `包含${listed}${more}`;
  if (policy.replyKeywordMatch === 'regex') return `匹配${listed}${more}`;
  return `以${listed}${more}开头`;
}

/** 追加在 DSH 通知正文末尾的回复规则提示；关键字为空时不加（关闭回传，没有可提示的规则）。 */
export function replyHintText(policy: NotifyReceiverConfigSection): string {
  if (parseKeywords(policy.replyKeywords).length === 0) return '';
  const stripped = policy.stripKeyword ? '；关键字会从转发内容里去掉' : '';
  return `\n（回复规则：${keywordPhrase(policy)}的消息会转给 DSH${stripped}。）`;
}
