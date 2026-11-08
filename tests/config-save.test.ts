import { afterEach, describe, expect, it } from 'vitest';
import { NOTIFY_RECEIVER_DEFAULTS } from '../src/config.ts';
import {
  NOTIFY_RECEIVER_CONFIG_KEYS,
  configValues,
  sanitizeConfigPatch,
  type CurrentBinding,
} from '../src/config-save.ts';
import { startBridge, type StartedBridge } from './helpers/bridge.ts';

const bridges: StartedBridge[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
});

const binding: CurrentBinding = { host: '127.0.0.1', port: 3210 };

/** 0.3.3 删掉的 6 个回传配置项；显式提交必须按未知键拒绝。 */
const REMOVED_BY_0_3_3: Readonly<Record<string, unknown>> = {
  replyMode: 'keyword',
  replyWindowMs: 60_000,
  replyWindowStart: 'coo_said',
  maxRepliesPerNotification: 1,
  replyOnFailed: true,
  replyCooldownMs: 0,
};

/** 0.3.2 删掉的 4 个配置项；仍按未知键拒绝。 */
const REMOVED_BY_0_3_2: Readonly<Record<string, unknown>> = {
  ignorePetAnswers: false,
  offlineReplyTtlMs: 600_000,
  showReplyHint: false,
  replyKeywordCaseSensitive: true,
};

describe('config.save 校验与夹取', () => {
  it('数值夹取到约定范围', () => {
    const { patch } = sanitizeConfigPatch({
      port: 70_000,
      heartbeatSec: 5,
      maxDevices: 100,
    }, binding);
    expect(patch).toEqual({
      port: 65_535,
      heartbeatSec: 10,
      maxDevices: 64,
    });
  });

  it('下界也夹取（负数、0、超小值）', () => {
    const { patch } = sanitizeConfigPatch({
      port: -1,
      heartbeatSec: -30,
      maxDevices: 0,
    }, binding);
    expect(patch).toEqual({
      port: 0,
      heartbeatSec: 10,
      maxDevices: 1,
    });
  });

  it('上界：心跳 300 秒、设备 64 台', () => {
    const { patch } = sanitizeConfigPatch({
      heartbeatSec: 999,
      maxDevices: 999,
    }, binding);
    expect(patch).toMatchObject({ heartbeatSec: 300, maxDevices: 64 });
  });

  it('枚举值校验：replyKeywordMatch / deviceInText', () => {
    expect(() => sanitizeConfigPatch({ replyKeywordMatch: 'fuzzy' }, binding)).toThrow(/replyKeywordMatch/);
    expect(() => sanitizeConfigPatch({ deviceInText: 'sometimes' }, binding)).toThrow(/deviceInText/);
  });

  it('未知键拒绝，且不会被写进补丁', () => {
    expect(() => sanitizeConfigPatch({ notAField: 1 }, binding)).toThrow(/未知配置项：notAField/);
    expect(() => sanitizeConfigPatch({ 'worlds.notify-receiver.host': '0.0.0.0' }, binding))
      .toThrow(/未知配置项/);
  });

  it('0.3.3 删掉的 6 项按未知键拒绝（不再有回传模式/窗口/次数/冷却）', () => {
    for (const [key, value] of Object.entries(REMOVED_BY_0_3_3)) {
      expect(() => sanitizeConfigPatch({ [key]: value }, binding)).toThrow(`未知配置项：${key}`);
      expect(NOTIFY_RECEIVER_CONFIG_KEYS as readonly string[]).not.toContain(key);
      expect(configValues(undefined)).not.toHaveProperty(key);
    }
  });

  it('0.3.2 删掉的 4 项也仍按未知键拒绝', () => {
    for (const [key, value] of Object.entries(REMOVED_BY_0_3_2)) {
      expect(() => sanitizeConfigPatch({ [key]: value }, binding)).toThrow(`未知配置项：${key}`);
      expect(NOTIFY_RECEIVER_CONFIG_KEYS as readonly string[]).not.toContain(key);
      expect(configValues(undefined)).not.toHaveProperty(key);
    }
  });

  it('补丁必须是对象；布尔项必须是布尔值', () => {
    expect(() => sanitizeConfigPatch('nope', binding)).toThrow(/对象/);
    expect(() => sanitizeConfigPatch({ stripKeyword: 'true' }, binding)).toThrow(/stripKeyword/);
  });

  it('字符串 trim，数字字符串也接受', () => {
    const { patch } = sanitizeConfigPatch({
      host: '  0.0.0.0  ',
      replyKeywords: '  回复, 转给DSH  ',
      heartbeatSec: '45',
    }, binding);
    expect(patch).toEqual({ host: '0.0.0.0', replyKeywords: '回复, 转给DSH', heartbeatSec: 45 });
    expect(() => sanitizeConfigPatch({ host: '   ' }, binding)).toThrow(/不能为空/);
  });

  it('restartRequired：host/port 变了才 true', () => {
    expect(sanitizeConfigPatch({ host: '0.0.0.0' }, binding).restartRequired).toBe(true);
    expect(sanitizeConfigPatch({ host: ' 127.0.0.1 ' }, binding).restartRequired).toBe(false);
    expect(sanitizeConfigPatch({ port: 4000 }, binding).restartRequired).toBe(true);
    expect(sanitizeConfigPatch({ port: 3210 }, binding).restartRequired).toBe(false);
    expect(sanitizeConfigPatch({ heartbeatSec: 45 }, binding).restartRequired).toBe(false);
    expect(sanitizeConfigPatch({ maxDevices: 2, host: '0.0.0.0' }, binding).restartRequired).toBe(true);
  });

  it('configValues 合并默认值，且只含面板字段', () => {
    const values = configValues({ host: '0.0.0.0' });
    expect(values.host).toBe('0.0.0.0');
    expect(values.port).toBe(NOTIFY_RECEIVER_DEFAULTS.port);
    expect(values.replyKeywords).toBe(NOTIFY_RECEIVER_DEFAULTS.replyKeywords);
    expect(values).not.toHaveProperty('enabled');
    expect(Object.keys(values).sort()).toEqual([...NOTIFY_RECEIVER_CONFIG_KEYS].sort());
  });
});

describe('config.save 面板调用', () => {
  it('校验后写回 persist，返回夹取后的 values 与 restartRequired', async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const invoke = bridge.world.webUi().invoke!;
    const result = await invoke('service', 'config.save', [{
      maxDevices: 100,
      replyKeywords: '  回复, 转给DSH  ',
      host: '0.0.0.0',
    }]) as {
      values: Record<string, string | number | boolean>;
      restartRequired: boolean;
    };
    expect(result.restartRequired).toBe(true);
    expect(result.values.maxDevices).toBe(64);
    expect(result.values.replyKeywords).toBe('回复, 转给DSH');
    expect(bridge.persisted).toEqual([{ maxDevices: 64, replyKeywords: '回复, 转给DSH', host: '0.0.0.0' }]);
    // 写回后 state 与状态工具读的是同一份活配置。
    const state = await invoke('service', 'state', []) as { values: Record<string, unknown> };
    expect(state.values.maxDevices).toBe(64);
    expect(state.values.replyKeywords).toBe('回复, 转给DSH');
  });

  it('只改热字段时 restartRequired 为 false', async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const result = await bridge.world.webUi().invoke!('service', 'config.save', [{ heartbeatSec: 45 }]) as {
      restartRequired: boolean;
    };
    expect(result.restartRequired).toBe(false);
    expect(bridge.persisted).toEqual([{ heartbeatSec: 45 }]);
  });

  it('未知键 / 已删除键 / 非法枚举时拒绝，且不调用 persist', async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const invoke = bridge.world.webUi().invoke!;
    await expect(invoke('service', 'config.save', [{ nope: 1 }])).rejects.toThrow(/未知配置项/);
    await expect(invoke('service', 'config.save', [{ replyMode: 'keyword' }]))
      .rejects.toThrow(/未知配置项：replyMode/);
    await expect(invoke('service', 'config.save', [{ replyWindowMs: 60_000 }]))
      .rejects.toThrow(/未知配置项：replyWindowMs/);
    await expect(invoke('service', 'config.save', [{ replyKeywordMatch: 'bogus' }]))
      .rejects.toThrow(/replyKeywordMatch/);
    await expect(invoke('service', 'config.save', [null])).rejects.toThrow(/对象/);
    expect(bridge.persisted).toEqual([]);
  });

  it('关键字留空也能保存：等于关闭回传', async () => {
    const bridge = await startBridge();
    bridges.push(bridge);
    const invoke = bridge.world.webUi().invoke!;
    const result = await invoke('service', 'config.save', [{ replyKeywords: '' }]) as {
      values: Record<string, string | number | boolean>;
    };
    expect(result.values.replyKeywords).toBe('');
    expect(bridge.persisted).toEqual([{ replyKeywords: '' }]);
    const state = await invoke('service', 'state', []) as { values: Record<string, unknown> };
    expect(state.values.replyKeywords).toBe('');
  });
});
