import { describe, expect, it } from 'vitest';
import { NOTIFY_RECEIVER_DEFAULTS, type NotifyReceiverConfigSection } from '../src/config.ts';
import { matchReplyText, parseKeywords, replyHintText } from '../src/reply-policy.ts';

const policy = (overrides: Partial<NotifyReceiverConfigSection> = {}): NotifyReceiverConfigSection => ({
  ...NOTIFY_RECEIVER_DEFAULTS,
  replyKeywords: '回复,转给DSH',
  replyKeywordMatch: 'prefix',
  stripKeyword: true,
  ...overrides,
});

describe('回复策略（纯关键字）', () => {
  it('关键字列表支持中英文逗号、分号和换行', () => {
    expect(parseKeywords('回复,转给DSH，dsh;你好\n在吗')).toEqual(['回复', '转给DSH', 'dsh', '你好', '在吗']);
    expect(parseKeywords('  ')).toEqual([]);
  });

  it('没有回传模式：普通消息不命中，只有关键字命中才算回复', () => {
    expect(matchReplyText('把测试跑一下', policy())).toEqual({ matched: false, text: '' });
    expect(matchReplyText('回复：把测试跑一下', policy())).toMatchObject({ matched: true });
  });

  it('前缀匹配并去掉关键字和紧跟的标点', () => {
    expect(matchReplyText('回复：把测试跑一下', policy())).toMatchObject({
      matched: true,
      text: '把测试跑一下',
      keyword: '回复',
    });
    expect(matchReplyText('转给DSH 继续', policy())).toMatchObject({ matched: true, text: '继续' });
    expect(matchReplyText('普通聊天', policy())).toEqual({ matched: false, text: '' });
  });

  it('包含匹配、正则匹配', () => {
    const contains = policy({ replyKeywordMatch: 'contains', replyKeywords: 'DSH' });
    expect(matchReplyText('帮我转给DSH一下', contains)).toMatchObject({ matched: true, text: '帮我转给一下' });

    const regex = policy({ replyKeywordMatch: 'regex', replyKeywords: '^/dsh\\s+' });
    expect(matchReplyText('/dsh 跑测试', regex)).toMatchObject({ matched: true, text: '跑测试' });
  });

  it('关键字匹配固定大小写不敏感（不再有开关）', () => {
    expect(matchReplyText('reply: fix it', policy({ replyKeywords: 'Reply' })).matched).toBe(true);
    expect(matchReplyText('REPLY: fix it', policy({ replyKeywords: 'reply' }))).toMatchObject({
      matched: true,
      text: 'fix it',
      keyword: 'reply',
    });
    // 去掉关键字时按原始长度切，保留下来的正文不改大小写。
    expect(matchReplyText('Reply: Fix It', policy({ replyKeywords: 'reply' })).text).toBe('Fix It');
    // 正则模式也始终带 i 标志。
    const regex = policy({ replyKeywordMatch: 'regex', replyKeywords: '^/DSH\\s+' });
    expect(matchReplyText('/dsh 跑测试', regex).matched).toBe(true);
  });

  it('不删关键字时转发原文；删完为空则不转发', () => {
    expect(matchReplyText('回复：继续', policy({ stripKeyword: false }))).toMatchObject({
      matched: true,
      text: '回复：继续',
    });
    expect(matchReplyText('回复：', policy()).matched).toBe(false);
  });

  it('关键字留空时任何消息都不命中（等同于关闭回传）', () => {
    for (const text of ['回复：把测试跑一下', '转给DSH 继续', '普通聊天']) {
      expect(matchReplyText(text, policy({ replyKeywords: '  ' }))).toEqual({ matched: false, text: '' });
    }
  });

  it('提示文本只讲关键字，不提时间或条数', () => {
    const hint = replyHintText(policy());
    expect(hint).toContain('回复规则');
    expect(hint).toContain('以「回复」或「转给DSH」开头');
    expect(hint).toContain('关键字会从转发内容里去掉');
    expect(hint).not.toMatch(/秒|时间|条数|最多/);
  });

  it('关键字留空时不写提示', () => {
    expect(replyHintText(policy({ replyKeywords: '' }))).toBe('');
  });

  it('不同匹配方式与去关键字开关只影响措辞', () => {
    expect(replyHintText(policy({ replyKeywordMatch: 'contains' }))).toContain('包含');
    expect(replyHintText(policy({ replyKeywordMatch: 'regex' }))).toContain('匹配');
    expect(replyHintText(policy({ stripKeyword: false }))).not.toContain('去掉');
  });
});
