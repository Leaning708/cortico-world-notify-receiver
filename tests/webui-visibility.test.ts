import { describe, expect, it } from 'vitest';
import {
  REPLY,
  SERVICE,
  fieldNote,
  panelStateNote,
  pickVisible,
  visibleFieldKeys,
} from '../src/webui/specs.ts';

/** 0.3.3 之后回传规则页只剩这三个字段。 */
const REPLY_KEYS = ['replyKeywords', 'replyKeywordMatch', 'stripKeyword'];

/** 0.3.2 从配置与面板里删掉的键；只允许出现在“已删除”的断言里。 */
const REMOVED_REPLY_KEYS = [
  'ignorePetAnswers',
  'offlineReplyTtlMs',
  'showReplyHint',
  'replyKeywordCaseSensitive',
  // 0.3.3 删掉的模式/窗口/次数/冷却字段。
  'replyMode',
  'replyWindowMs',
  'replyWindowStart',
  'maxRepliesPerNotification',
  'replyOnFailed',
  'replyCooldownMs',
] as const;

describe('回传规则面板（纯关键字）', () => {
  it('只剩关键字、匹配方式与去关键字三个字段', () => {
    expect(REPLY.fields.map((field) => field.key)).toEqual(REPLY_KEYS);
    expect(visibleFieldKeys(REPLY.fields, {})).toEqual(REPLY_KEYS);
  });

  it('不再有按模式显示的条件与「回传关闭」说明', () => {
    for (const field of REPLY.fields) {
      expect(field.when).toBeUndefined();
      expect(field.labelBy).toBeUndefined();
      expect(field.noteBy).toBeUndefined();
    }
    expect(REPLY.stateNotes).toBeUndefined();
    expect(panelStateNote(REPLY, {})).toBeUndefined();
  });

  it('0.3.2 / 0.3.3 删掉的字段不出现在面板声明里', () => {
    const keys = REPLY.fields.map((field) => field.key);
    for (const removed of REMOVED_REPLY_KEYS) expect(keys).not.toContain(removed);
  });

  it('关键字字段说明写明留空等于关闭回传', () => {
    const keywords = REPLY.fields.find((field) => field.key === 'replyKeywords')!;
    expect(fieldNote(keywords, {})).toContain('留空表示不转发');
  });

  it('服务页字段没有显示条件', () => {
    expect(visibleFieldKeys(SERVICE.fields, {})).toEqual([
      'host',
      'port',
      'heartbeatSec',
      'maxDevices',
      'allowAnonymousLoopback',
      'deviceInText',
      'announceConnections',
    ]);
  });
});

describe('保存时只提交面板字段', () => {
  it('三个字段全部写回', () => {
    const draft = { replyKeywords: '回复', replyKeywordMatch: 'prefix', stripKeyword: true };
    expect(pickVisible(REPLY.fields, draft)).toEqual(draft);
  });

  it('草稿里夹带的已删除键不会被写回', () => {
    const draft = {
      replyKeywords: '回复',
      replyMode: 'both',
      replyWindowMs: 9_000,
      maxRepliesPerNotification: 3,
    };
    expect(pickVisible(REPLY.fields, draft)).toEqual({ replyKeywords: '回复' });
  });
});
