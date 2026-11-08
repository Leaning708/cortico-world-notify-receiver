/**
 * 面板保存通道的纯逻辑：`config.save` 的字段校验、数值夹取、默认值合并。
 *
 * 不依赖 DOM 或 fs，浏览器侧（可见性规则）与 Node 侧（World invoke）都能用；
 * 单独放一个文件是为了让单测直接覆盖校验表，而不必起一个 WS 服务端。
 */
import {
  NOTIFY_RECEIVER_DEFAULTS,
  type DeviceInText,
  type NotifyReceiverConfigSection,
  type ReplyKeywordMatch,
} from './config.ts';

/** 面板里能读写的值；与 `NotifyReceiverConfigSection` 的字段类型一致。 */
export type NotifyReceiverValue = string | number | boolean;

/** 面板可保存的字段：不含 `enabled`（启停由框架与部署配置决定）。 */
export type NotifyReceiverConfigKey = Exclude<keyof NotifyReceiverConfigSection, 'enabled'>;

/** 保存白名单；不在表里的键一律拒绝，避免面板把笔误写进 config.json。 */
export const NOTIFY_RECEIVER_CONFIG_KEYS = [
  'host',
  'port',
  'heartbeatSec',
  'maxDevices',
  'allowAnonymousLoopback',
  'deviceInText',
  'announceConnections',
  'replyKeywords',
  'replyKeywordMatch',
  'stripKeyword',
] as const satisfies readonly NotifyReceiverConfigKey[];

export const REPLY_KEYWORD_MATCHES = ['prefix', 'contains', 'regex'] as const satisfies readonly ReplyKeywordMatch[];
export const DEVICE_IN_TEXT_VALUES = ['auto', 'always', 'never'] as const satisfies readonly DeviceInText[];

/** 当前绑定参数；只有 host/port 变了才需要重启 World。 */
export type CurrentBinding = Pick<NotifyReceiverConfigSection, 'host' | 'port'>;

/** 保存后的结果：写回配置的补丁，以及是否要重启 World 才生效。 */
export interface SanitizedConfigPatch {
  patch: Partial<NotifyReceiverConfigSection>;
  restartRequired: boolean;
}

const valueOf = (key: NotifyReceiverConfigKey): NotifyReceiverValue => NOTIFY_RECEIVER_DEFAULTS[key];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(raw: unknown, key: string, minimum: number, maximum: number): number {
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`配置项 ${key} 必须是数字`);
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function asString(raw: unknown, key: string): string {
  if (typeof raw !== 'string') throw new Error(`配置项 ${key} 必须是字符串`);
  return raw.trim();
}

function asBoolean(raw: unknown, key: string): boolean {
  if (typeof raw !== 'boolean') throw new Error(`配置项 ${key} 必须是 true 或 false`);
  return raw;
}

function asEnum<T extends string>(raw: unknown, key: string, allowed: readonly T[]): T {
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new Error(`配置项 ${key} 只能是 ${allowed.join(' / ')}`);
  }
  return raw as T;
}

/** 每种字段的校验/夹取规则；新增字段时补到这里，白名单与面板各自再补一处。 */
const SANITIZERS: Readonly<Record<NotifyReceiverConfigKey, (raw: unknown) => NotifyReceiverValue>> = {
  host: (raw) => {
    const value = asString(raw, 'host');
    if (!value) throw new Error('配置项 host 不能为空');
    return value;
  },
  port: (raw) => asNumber(raw, 'port', 0, 65_535),
  heartbeatSec: (raw) => asNumber(raw, 'heartbeatSec', 10, 300),
  maxDevices: (raw) => asNumber(raw, 'maxDevices', 1, 64),
  allowAnonymousLoopback: (raw) => asBoolean(raw, 'allowAnonymousLoopback'),
  deviceInText: (raw) => asEnum(raw, 'deviceInText', DEVICE_IN_TEXT_VALUES),
  announceConnections: (raw) => asBoolean(raw, 'announceConnections'),
  replyKeywords: (raw) => asString(raw, 'replyKeywords'),
  replyKeywordMatch: (raw) => asEnum(raw, 'replyKeywordMatch', REPLY_KEYWORD_MATCHES),
  stripKeyword: (raw) => asBoolean(raw, 'stripKeyword'),
};

/** 当前配置段的展示值：缺字段（旧配置/部分段）时补默认值，面板因此总能画出完整表单。 */
export function configValues(
  cfg: Partial<NotifyReceiverConfigSection> | undefined,
): Record<NotifyReceiverConfigKey, NotifyReceiverValue> {
  const values = {} as Record<NotifyReceiverConfigKey, NotifyReceiverValue>;
  for (const key of NOTIFY_RECEIVER_CONFIG_KEYS) {
    const value = cfg?.[key];
    values[key] = value === undefined || value === null ? valueOf(key) : value;
  }
  return values;
}

/**
 * 校验一个面板补丁：未知键拒绝、枚举校验、数值夹取、字符串 trim。
 * `current` 用当前生效值判断 host/port 是否真的变了（决定要不要提示重启 World）。
 */
export function sanitizeConfigPatch(
  input: unknown,
  current: CurrentBinding,
): SanitizedConfigPatch {
  if (!isPlainObject(input)) throw new Error('配置补丁必须是一个对象');
  const patch: Partial<NotifyReceiverConfigSection> = {};
  const writable = patch as Record<string, NotifyReceiverValue>;
  let restartRequired = false;

  for (const [key, raw] of Object.entries(input)) {
    if (!(NOTIFY_RECEIVER_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`未知配置项：${key}`);
    }
    const configKey = key as NotifyReceiverConfigKey;
    writable[key] = SANITIZERS[configKey](raw);
    if (configKey === 'host') {
      restartRequired ||= writable.host !== String(current.host ?? '').trim();
    } else if (configKey === 'port') {
      const bound = Number(current.port);
      restartRequired ||= !Number.isFinite(bound) || Math.round(bound) !== writable.port;
    }
  }

  return { patch, restartRequired };
}
