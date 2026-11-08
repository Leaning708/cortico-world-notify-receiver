import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  closeCodeForError,
  encodeServerFrame,
  frameByteLength,
  isFrameTooLarge,
  parseClientFrame,
  parseClientFrameText,
} from '../src/protocol.ts';
import { baseFrame } from './helpers/ws-client.ts';

const hello = (overrides: Record<string, unknown> = {}) => ({
  ...baseFrame('hello'),
  deviceId: 'dev-1',
  deviceName: '家里台式机',
  client: 'dsh',
  clientVersion: '0.3.0',
  features: ['task.v1'],
  ...overrides,
});

const task = (overrides: Record<string, unknown> = {}) => ({
  ...baseFrame('task'),
  msgId: 'msg-1',
  status: 'completed',
  title: '修复登录页',
  text: '测试通过',
  sessionId: 'session-1',
  ...overrides,
});

describe('dsh-notify.ws.v1 帧校验', () => {
  it('帧形状与设计稿第 3 节一致：公共字段 v/type/id/at', () => {
    const parsed = parseClientFrame(hello());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame).toMatchObject({
      v: PROTOCOL_VERSION,
      type: 'hello',
      deviceId: 'dev-1',
      deviceName: '家里台式机',
      client: 'dsh',
      clientVersion: '0.3.0',
      features: ['task.v1'],
    });
    expect(typeof parsed.frame.id).toBe('string');
    expect(parsed.frame.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('hello 的 deviceName/client/clientVersion/features 都有缺省值', () => {
    const parsed = parseClientFrame(hello({
      deviceName: undefined,
      client: undefined,
      clientVersion: undefined,
      features: 'nope',
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame).toMatchObject({
      deviceName: 'dev-1',
      client: 'dsh',
      clientVersion: '',
      features: [],
    });
  });

  it('task 解析出 msgId 与规范化后的通知', () => {
    const parsed = parseClientFrame(task({ turn: 3, durationMs: 65_000 }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.type !== 'task') return;
    expect(parsed.frame.msgId).toBe('msg-1');
    expect(parsed.frame.note).toMatchObject({
      status: 'completed',
      title: '修复登录页',
      text: '测试通过',
      sessionId: 'session-1',
      turn: 3,
      durationMs: 65_000,
    });
  });

  it('reply-result / pong / bye 都能解析', () => {
    const result = parseClientFrame({ ...baseFrame('reply-result'), replyId: 'r-1', ok: false, error: '坏了' });
    expect(result.ok && result.frame).toMatchObject({ type: 'reply-result', replyId: 'r-1', ok: false, error: '坏了' });

    const pong = parseClientFrame({ ...baseFrame('pong') });
    expect(pong.ok).toBe(true);

    const bye = parseClientFrame({ ...baseFrame('bye'), reason: '插件停用' });
    expect(bye.ok && bye.frame).toMatchObject({ type: 'bye', reason: '插件停用' });
  });

  it('缺字段、未知 type、版本不符都拒绝', () => {
    const cases: Array<[string, unknown]> = [
      ['不是对象', ['nope']],
      ['null', null],
      ['缺 type', { v: 1, id: 'x', at: 'now' }],
      ['未知 type', { ...baseFrame('whatever') }],
      ['版本不符', { ...hello(), v: 2 }],
      ['缺 v', { type: 'pong' }],
      ['hello 缺 deviceId', hello({ deviceId: '' })],
      ['task 缺 msgId', task({ msgId: '' })],
      ['task 状态不合法', task({ status: 'weird' })],
      ['reply-result 缺 replyId', { ...baseFrame('reply-result'), ok: true }],
      ['reply-result 缺 ok', { ...baseFrame('reply-result'), replyId: 'r-1' }],
    ];
    for (const [label, raw] of cases) {
      const parsed = parseClientFrame(raw);
      expect(parsed.ok, label).toBe(false);
      if (!parsed.ok) expect(parsed.error.code, label).toBe('bad_frame');
    }
  });

  it('文本帧超长、坏 JSON、空帧都按协议报错', () => {
    const tooLarge = 'x'.repeat(MAX_FRAME_BYTES + 10);
    const parsedBig = parseClientFrameText(JSON.stringify({ ...task(), text: tooLarge }));
    expect(parsedBig.ok).toBe(false);
    if (!parsedBig.ok) expect(parsedBig.error.code).toBe('payload_too_large');

    const badJson = parseClientFrameText('{not json');
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error.code).toBe('bad_frame');

    expect(parseClientFrameText('').ok).toBe(false);
  });

  it('字节上限按 UTF-8 计算', () => {
    const ascii = 'a'.repeat(10);
    expect(frameByteLength(ascii)).toBe(10);
    expect(frameByteLength('中')).toBe(3);
    expect(isFrameTooLarge('a'.repeat(MAX_FRAME_BYTES))).toBe(false);
    expect(isFrameTooLarge('a'.repeat(MAX_FRAME_BYTES + 1))).toBe(true);
  });

  it('编码服务端帧会补公共字段；reply 的 at 用消息时刻', () => {
    const ack = JSON.parse(encodeServerFrame({ type: 'ack', ref: 'msg-1', cursor: 7 })) as Record<string, unknown>;
    expect(ack).toMatchObject({ v: PROTOCOL_VERSION, type: 'ack', ref: 'msg-1', cursor: 7 });
    expect(typeof ack.id).toBe('string');
    expect(typeof ack.at).toBe('string');

    const at = '2026-11-02T10:00:00.000Z';
    const reply = JSON.parse(encodeServerFrame({
      type: 'reply',
      replyId: 'r-1',
      taskId: 'msg-1',
      sessionId: 'session-1',
      text: '跑一下测试',
    }, { at })) as Record<string, unknown>;
    expect(reply.at).toBe(at);

    const helloOk = JSON.parse(encodeServerFrame({
      type: 'hello-ok',
      serverVersion: '0.3.0',
      deviceId: 'dev-1',
      heartbeatSec: 30,
      limits: { maxFrameBytes: MAX_FRAME_BYTES, maxReplyChars: 8000 },
    })) as Record<string, unknown>;
    expect(helloOk).toMatchObject({
      type: 'hello-ok',
      heartbeatSec: 30,
      limits: { maxFrameBytes: 65_536, maxReplyChars: 8_000 },
    });
  });
});

describe('关闭码', () => {
  it('数值与设计稿第 3.3 节逐字一致', () => {
    expect(CLOSE_CODES).toEqual({
      normal: 1000,
      retryLater: 1013,
      unauthorized: 4401,
      revoked: 4403,
      helloTimeout: 4408,
      replaced: 4409,
      frameTooLarge: 4413,
      tooManyDevices: 4429,
    });
  });

  it('错误码映射到关闭码；bad_frame / not_ready 只回错误帧', () => {
    expect(closeCodeForError('unauthorized')).toBe(4401);
    expect(closeCodeForError('rate_limited')).toBe(1013);
    expect(closeCodeForError('payload_too_large')).toBe(4413);
    expect(closeCodeForError('bad_frame')).toBeUndefined();
    expect(closeCodeForError('not_ready')).toBeUndefined();
  });
});
