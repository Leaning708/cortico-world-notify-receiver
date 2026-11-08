import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  parseDshTaskNote,
  renderTaskEventText,
  shouldShowDevice,
  TEXT_LIMIT,
  TITLE_LIMIT,
} from '../src/note.ts';

describe('DSH 通知正文', () => {
  it('status 缺省按完成处理,也接受 event 写法', () => {
    expect(parseDshTaskNote({ text: 'hi' })?.status).toBe('completed');
    expect(parseDshTaskNote({ event: 'task.failed', text: 'boom' })?.status).toBe('failed');
    expect(parseDshTaskNote({ status: 'failed' })?.status).toBe('failed');
  });

  it('拒绝不是对象的请求体', () => {
    expect(parseDshTaskNote(null)).toBeNull();
    expect(parseDshTaskNote('hi')).toBeNull();
    expect(parseDshTaskNote([])).toBeNull();
    expect(parseDshTaskNote({ status: 'unknown' })).toBeNull();
  });

  it('标题压成一行,正文保留换行,超长截断', () => {
    const note = parseDshTaskNote({
      title: `第一行\n第二行${'x'.repeat(TITLE_LIMIT)}`,
      text: `a\nb${'y'.repeat(TEXT_LIMIT)}`,
      device: '  dev\nbox  ',
    })!;
    expect(note.title.startsWith('第一行 第二行')).toBe(true);
    expect(note.title.endsWith('…')).toBe(true);
    expect(note.title.length).toBe(TITLE_LIMIT + 1);
    expect(note.text).toContain('\n');
    expect(note.text.length).toBe(TEXT_LIMIT + 1);
    expect(note.device).toBe('dev box');
  });

  it('耗时格式', () => {
    expect(formatDuration(800)).toBe('800 毫秒');
    expect(formatDuration(9_000)).toBe('9 秒');
    expect(formatDuration(60_000)).toBe('1 分');
    expect(formatDuration(65_000)).toBe('1 分 5 秒');
    expect(formatDuration(3_600_000)).toBe('1 小时');
    expect(formatDuration(3_780_000)).toBe('1 小时 3 分');
  });

  it('事件正文只陈述事实', () => {
    const note = parseDshTaskNote({
      status: 'completed',
      device: 'dev-box',
      title: '修复登录页',
      text: '测试全部通过',
      durationMs: 65_000,
    })!;
    expect(renderTaskEventText(note)).toBe(
      '[DSH 任务完成]｜设备：dev-box｜会话：修复登录页｜用时：1 分 5 秒\n最后回复：测试全部通过',
    );
    expect(renderTaskEventText({ ...note, text: '' })).toBe(
      '[DSH 任务完成]｜设备：dev-box｜会话：修复登录页｜用时：1 分 5 秒',
    );
  });

  it('deviceInText：auto 多设备才写、always 总写、never 不写', () => {
    const note = parseDshTaskNote({
      status: 'completed',
      device: 'dev-box',
      title: '修复登录页',
    })!;
    expect(shouldShowDevice()).toBe(true);
    expect(shouldShowDevice({ deviceInText: 'always' })).toBe(true);
    expect(shouldShowDevice({ deviceInText: 'never' })).toBe(false);
    expect(shouldShowDevice({ deviceInText: 'auto', knownDevices: 1 })).toBe(false);
    expect(shouldShowDevice({ deviceInText: 'auto', knownDevices: 2 })).toBe(true);
    expect(shouldShowDevice({ deviceInText: 'auto' })).toBe(false);

    expect(renderTaskEventText(note, { deviceInText: 'auto', knownDevices: 1 }))
      .toBe('[DSH 任务完成]｜会话：修复登录页');
    expect(renderTaskEventText(note, { deviceInText: 'auto', knownDevices: 3 }))
      .toContain('设备：dev-box');
    expect(renderTaskEventText(note, { deviceInText: 'never' })).not.toContain('设备：');
  });
});
