/**
 * `dsh-notify.ws.v1` 的帧定义、纯函数校验/编码与关闭码。
 * 这里只做形状与长度校验，不碰网络、文件与宿主；`ws-server.ts` 负责搬运。
 * 帧形状与 `docs/WS-DESIGN.md` 第 3 节逐字一致。
 */
import { randomUUID } from 'node:crypto';
import { parseDshTaskNote, type DshTaskNote } from './note.ts';

/** 协议名；hello-ok 不单独回它，握手成功即表示按这版说话。 */
export const PROTOCOL_NAME = 'dsh-notify.ws.v1';
/** 公共字段 `v`。 */
export const PROTOCOL_VERSION = 1;

export const WS_PATH = '/ws';
export const HEALTH_PATH = '/health';

/** 单帧上限（UTF-8 字节）。 */
export const MAX_FRAME_BYTES = 64 * 1024;
/** 回传文本上限；任务摘要由 `note.ts` 限到 4000 字符。 */
export const MAX_REPLY_CHARS = 8000;
/** 连接建立后必须在这个时间内发 `hello`。 */
export const HELLO_TIMEOUT_MS = 5_000;

export const MAX_DEVICE_ID_CHARS = 120;
export const MAX_DEVICE_NAME_CHARS = 80;
export const MAX_CLIENT_CHARS = 32;
export const MAX_CLIENT_VERSION_CHARS = 40;
export const MAX_FEATURE_CHARS = 60;
export const MAX_FEATURES = 32;
export const MAX_MSG_ID_CHARS = 120;
export const MAX_REPLY_ID_CHARS = 200;
export const MAX_REPLY_ERROR_CHARS = 400;
export const MAX_BYE_REASON_CHARS = 200;

/**
 * 关闭码（第 3.3 节）。数值不得改动：DSH 侧按这些值决定要不要重连。
 */
export const CLOSE_CODES = {
  /** 正常关闭（`bye` 或 Coopanion 停机前的礼貌关闭）。 */
  normal: 1000,
  /** 稍后重连（重启 World / 背压 / 触发限流）。 */
  retryLater: 1013,
  /** 令牌无效。 */
  unauthorized: 4401,
  /** 令牌已吊销 / Origin 不受信。 */
  revoked: 4403,
  /** 握手超时（没发 `hello`）。 */
  helloTimeout: 4408,
  /** 同 `deviceId` 的新连接顶掉了这条旧连接。 */
  replaced: 4409,
  /** 单帧超限。 */
  frameTooLarge: 4413,
  /** 设备数超过 `maxDevices`。 */
  tooManyDevices: 4429,
} as const;

export type CloseCodeName = keyof typeof CLOSE_CODES;

/** 服务端 `error` 帧的错误码（第 3.2 节）。 */
export type FrameErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'payload_too_large'
  | 'bad_frame'
  | 'not_ready';

export interface FrameError {
  code: FrameErrorCode;
  message: string;
  ref?: string;
}

/** 客户端帧共用字段。 */
export interface ClientFrameBase {
  v: number;
  /** `hello` / `task` / `reply-result` / `pong` / `bye`。 */
  type: string;
  /** 发送方生成的帧 id，便于日志对照；缺省为空串。 */
  id: string;
  /** 发送时刻（ISO8601）；缺省为空串。 */
  at: string;
}

export interface HelloFrame extends ClientFrameBase {
  type: 'hello';
  /** 握手头里没带令牌时用这个。 */
  token?: string;
  deviceId: string;
  deviceName: string;
  /** 目前只有 `"dsh"`；保留字段给以后其他 app。 */
  client: string;
  clientVersion: string;
  features: string[];
}

export interface TaskFrame extends ClientFrameBase {
  type: 'task';
  /** 客户端生成的通知 id；服务端按它去重。 */
  msgId: string;
  note: DshTaskNote;
}

export interface ReplyResultFrame extends ClientFrameBase {
  type: 'reply-result';
  replyId: string;
  ok: boolean;
  error?: string;
}

export interface PongFrame extends ClientFrameBase {
  type: 'pong';
}

export interface ByeFrame extends ClientFrameBase {
  type: 'bye';
  reason?: string;
}

export type ClientFrame = HelloFrame | TaskFrame | ReplyResultFrame | PongFrame | ByeFrame;

/** 服务端帧的载荷部分；`v/type/id/at` 由 `encodeServerFrame` 补。 */
export type ServerFrameBody =
  | {
      type: 'hello-ok';
      serverVersion: string;
      deviceId: string;
      heartbeatSec: number;
      limits: { maxFrameBytes: number; maxReplyChars: number };
    }
  | { type: 'ack'; ref: string; cursor: number; duplicate?: boolean }
  | { type: 'reply'; replyId: string; taskId: string; sessionId: string; text: string }
  | { type: 'ping'; ts: string }
  | { type: 'error'; code: FrameErrorCode; message: string; ref?: string };

/** 落到线上的服务端帧（编码后的形状）。 */
export type ServerFrame = ServerFrameBody & { v: number; id: string; at: string };

export type FrameParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; error: FrameError };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (code: FrameErrorCode, message: string, ref?: string): FrameParseResult => ({
  ok: false,
  error: ref === undefined ? { code, message } : { code, message, ref },
});

/** 取一个去首尾空白的字符串字段；超长时截断成 `…`。非字符串返回空串。 */
function readString(value: unknown, limit: number, collapse = false): string {
  if (typeof value !== 'string') return '';
  const text = collapse ? value.replace(/\s+/g, ' ').trim() : value.trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function readRequiredString(value: unknown, limit: number): string | undefined {
  const text = readString(value, limit, true);
  return text ? text : undefined;
}

function readFeatures(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const features: string[] = [];
  for (const item of value) {
    const text = readString(item, MAX_FEATURE_CHARS, true);
    if (text) features.push(text);
    if (features.length >= MAX_FEATURES) break;
  }
  return features;
}

/** 客户端帧解析：`{ ok: false }` 时调用方发 `error` 帧，必要时按 `closeCodeForError` 关闭。 */
export function parseClientFrame(raw: unknown): FrameParseResult {
  if (!isPlainObject(raw)) return fail('bad_frame', '帧必须是 JSON 对象');
  if (raw.v !== PROTOCOL_VERSION) {
    return fail('bad_frame', `不支持的协议版本 ${String(raw.v)}（需要 ${PROTOCOL_VERSION}）`);
  }
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!type) return fail('bad_frame', '缺少 type');
  const id = typeof raw.id === 'string' ? raw.id : '';
  const at = typeof raw.at === 'string' ? raw.at : '';

  switch (type) {
    case 'hello':
      return parseHello(raw, id, at);
    case 'task':
      return parseTask(raw, id, at);
    case 'reply-result':
      return parseReplyResult(raw, id, at);
    case 'pong':
      return { ok: true, frame: { v: PROTOCOL_VERSION, type: 'pong', id, at } };
    case 'bye': {
      const reason = readString(raw.reason, MAX_BYE_REASON_CHARS, true);
      return {
        ok: true,
        frame: { v: PROTOCOL_VERSION, type: 'bye', id, at, ...(reason ? { reason } : {}) },
      };
    }
    default:
      return fail('bad_frame', `未知帧类型：${type}`);
  }
}

function parseHello(raw: Record<string, unknown>, id: string, at: string): FrameParseResult {
  const deviceId = readRequiredString(raw.deviceId, MAX_DEVICE_ID_CHARS);
  if (!deviceId) return fail('bad_frame', 'hello 缺少 deviceId');
  const deviceName = readString(raw.deviceName, MAX_DEVICE_NAME_CHARS, true) || deviceId;
  const client = readString(raw.client, MAX_CLIENT_CHARS, true) || 'dsh';
  const clientVersion = readString(raw.clientVersion, MAX_CLIENT_VERSION_CHARS, true);
  const token = readString(raw.token, 512, false);
  const frame: HelloFrame = {
    v: PROTOCOL_VERSION,
    type: 'hello',
    id,
    at,
    deviceId,
    deviceName,
    client,
    clientVersion,
    features: readFeatures(raw.features),
    ...(token ? { token } : {}),
  };
  return { ok: true, frame };
}

function parseTask(raw: Record<string, unknown>, id: string, at: string): FrameParseResult {
  const msgId = readRequiredString(raw.msgId, MAX_MSG_ID_CHARS);
  if (!msgId) return fail('bad_frame', 'task 缺少 msgId');
  const status = raw.status;
  if (status !== 'completed' && status !== 'failed'
    && status !== 'task.completed' && status !== 'task.failed') {
    return fail('bad_frame', 'task 的 status 必须是 completed 或 failed', msgId);
  }
  const note = parseDshTaskNote(raw);
  if (!note) return fail('bad_frame', 'task 的字段形状不对', msgId);
  return { ok: true, frame: { v: PROTOCOL_VERSION, type: 'task', id, at, msgId, note } };
}

function parseReplyResult(raw: Record<string, unknown>, id: string, at: string): FrameParseResult {
  const replyId = readRequiredString(raw.replyId, MAX_REPLY_ID_CHARS);
  if (!replyId) return fail('bad_frame', 'reply-result 缺少 replyId');
  if (typeof raw.ok !== 'boolean') return fail('bad_frame', 'reply-result 缺少 ok', replyId);
  const error = readString(raw.error, MAX_REPLY_ERROR_CHARS, true);
  const frame: ReplyResultFrame = {
    v: PROTOCOL_VERSION,
    type: 'reply-result',
    id,
    at,
    replyId,
    ok: raw.ok,
    ...(error ? { error } : {}),
  };
  return { ok: true, frame };
}

/** 文本帧的字节数；UTF-8 下与 `ws` 的 `maxPayload` 口径一致。 */
export function frameByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 是否超过单帧上限。 */
export function isFrameTooLarge(text: string): boolean {
  return frameByteLength(text) > MAX_FRAME_BYTES;
}

/** 文本帧解析：JSON 都读不出来时同样按 `bad_frame` 处理。 */
export function parseClientFrameText(text: string): FrameParseResult {
  if (typeof text !== 'string' || !text) return fail('bad_frame', '空帧');
  if (isFrameTooLarge(text)) {
    return fail('payload_too_large', `帧超过 ${MAX_FRAME_BYTES} 字节`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('bad_frame', '不是合法的 JSON');
  }
  return parseClientFrame(parsed);
}

/**
 * 编码服务端帧：补上公共字段 `v/type/id/at`。
 * `meta.at` 用于 `reply`（它的 `at` 是用户说话的时刻）；其余帧取当前时刻。
 */
export function encodeServerFrame(
  body: ServerFrameBody,
  meta: { id?: string; at?: string } = {},
): string {
  const frame: ServerFrame = {
    v: PROTOCOL_VERSION,
    ...body,
    id: meta.id ?? randomUUID(),
    at: meta.at ?? new Date().toISOString(),
  };
  return JSON.stringify(frame);
}

/**
 * 错误码到关闭码的映射：`undefined` 表示只回 `error` 帧、不断开。
 * 限流按第 3.3 节用 1013（稍后重连），单帧超限用 4413。
 */
export function closeCodeForError(code: FrameErrorCode): number | undefined {
  switch (code) {
    case 'unauthorized':
      return CLOSE_CODES.unauthorized;
    case 'rate_limited':
      return CLOSE_CODES.retryLater;
    case 'payload_too_large':
      return CLOSE_CODES.frameTooLarge;
    case 'bad_frame':
    case 'not_ready':
      return undefined;
  }
}
