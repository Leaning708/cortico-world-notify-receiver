/**
 * `dsh-notify.ws.v1` 服务端：`node:http` 上挂 `ws`（`noServer: true`），只有 `/ws` 走升级，
 * 同端口保留 `GET /health` 用于排障。
 *
 * 这一层只管连接：握手与鉴权、设备注册表、心跳、限流、背压、关闭码；
 * 事件投递、回复窗口与回传队列都在 `world.ts`，通过 `WsBridgeHooks` 回调上来。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  CLOSE_CODES,
  HEALTH_PATH,
  MAX_FRAME_BYTES,
  MAX_REPLY_CHARS,
  PROTOCOL_NAME,
  WS_PATH,
  closeCodeForError,
  encodeServerFrame,
  parseClientFrameText,
  type ClientFrame,
  type FrameError,
  type HelloFrame,
  type ReplyResultFrame,
  type ServerFrameBody,
  type TaskFrame,
} from './protocol.ts';
import type { DshTaskNote } from './note.ts';
import type { TokenStore } from './tokens.ts';

/** 只用到日志的三个方法；`WorldHost.log` 直接满足。 */
export interface BridgeLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  debug?(msg: string, data?: unknown): void;
}

/** 一条连接的静态身份，给回调用。 */
export interface WsBridgeConnection {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly tokenId?: string;
  readonly tokenLabel?: string;
  readonly client: string;
  readonly clientVersion: string;
  readonly features: readonly string[];
  readonly remoteAddress: string;
  /** 已收到的任务条数。 */
  readonly received: number;
  /** 发一帧；连接不可写或背压过高时返回 false。 */
  send(body: ServerFrameBody, meta?: { at?: string }): boolean;
  close(code?: number, reason?: string): void;
}

/** 设备注册表里的一条；离线设备保留最近一次记录，给面板和状态工具看。 */
export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  client: string;
  clientVersion: string;
  tokenId?: string;
  tokenLabel?: string;
  /** 本次连接建立时刻（毫秒）；离线设备保留上一次的值。 */
  connectedAt?: number;
  /** 最后一次收到帧的时刻（毫秒）。 */
  lastSeenAt: number;
  /** 累计收到的任务条数。 */
  received: number;
  online: boolean;
  remoteAddress?: string;
}

/** World 侧要实现的回调。 */
export interface WsBridgeHooks {
  /** 收到一条 `task`：落库后返回游标；`duplicate` 由服务端按 `msgId` 判定。 */
  onTask(
    conn: WsBridgeConnection,
    note: DshTaskNote,
    msgId: string,
  ): Promise<{ cursor: number; duplicate?: boolean }>;
  /** 设备完成 hello 并注册之后调用。 */
  onConnected(conn: WsBridgeConnection): void | Promise<void>;
  /** 连接断开（含被顶号、被踢）之后调用；`device.online` 已是 false。 */
  onDisconnected(device: DeviceInfo): void | Promise<void>;
  /** 收到 `reply-result`。 */
  onReplyResult(deviceId: string, replyId: string, ok: boolean, error?: string): void;
  /** 每次心跳扫描后调用；回复队列的离线 TTL 靠它。 */
  onTick?(): void;
}

export interface WsBridgeServerOptions {
  host: string;
  port: number;
  heartbeatSec: number;
  maxDevices: number;
  /** 没有任何可用令牌时，是否允许本机匿名连接（调试用）。 */
  allowAnonymousLoopback: boolean;
  tokens: TokenStore;
  /** 回给 `hello-ok.serverVersion`。 */
  version: string;
  hooks: WsBridgeHooks;
  /** 默认 5 秒；测试可以调小。 */
  helloTimeoutMs?: number;
  log?: BridgeLogger;
}

/** 心跳间隔、设备上限的内部夹取范围；配置面板另有更窄的 UI 范围。 */
export const MIN_HEARTBEAT_SEC = 0.05;
export const MAX_HEARTBEAT_SEC = 300;
export const MIN_MAX_DEVICES = 1;
export const MAX_MAX_DEVICES = 64;

/** 每个设备每 10 秒最多 60 帧；一次任务通知 + 心跳远低于它。 */
export const RATE_LIMIT_WINDOW_MS = 10_000;
export const RATE_LIMIT_MAX_FRAMES = 60;
/** 单条连接允许的待发字节数；超过就当作不可写，回传留在队列里。 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/**
 * `ws` 自身的硬上限。协议上限是 64 KiB；这里放到 2 倍，先由我们自己回 4413 再关，
 * 避免稍超一点就被 `ws` 直接以 1009 断开（1009 不在本协议关闭码里）。
 */
export const TRANSPORT_MAX_PAYLOAD = MAX_FRAME_BYTES * 2;
/** 每个设备记住多少个已处理的 `msgId`，用于断线重发去重。 */
export const SEEN_MSG_LIMIT = 256;

const DEFAULT_HELLO_TIMEOUT_MS = 5_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 空地址报错；`[::1]` 这种带方括号的写法去掉方括号。 */
export function normalizeHost(value: string): string {
  const host = String(value ?? '').trim();
  if (!host) throw new Error('worlds.notify-receiver.host 不能为空');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`worlds.notify-receiver.port 必须是 0 到 65535 的整数，收到 ${String(value)}`);
  }
  return value;
}

export function clampHeartbeatSec(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(MAX_HEARTBEAT_SEC, Math.max(MIN_HEARTBEAT_SEC, value));
}

export function clampMaxDevices(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(MAX_MAX_DEVICES, Math.max(MIN_MAX_DEVICES, Math.round(value)));
}

/** 回环地址不需要令牌；其余地址必须配令牌。 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

/** 对端是不是本机（`::ffff:127.0.0.1` 这种映射写法也算）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  const value = String(address ?? '').trim().toLowerCase();
  if (!value) return false;
  if (value === '::1' || value === 'localhost') return true;
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (mapped === '127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped);
}

export function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/** `Authorization: Bearer <token>`；没有就返回空串。 */
export function readBearerToken(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return '';
  const match = /^bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1]!.trim() : '';
}

/**
 * 跨站防护：带 `Origin` 且不是本机页面的握手一律拒绝。
 * 否则恶意网页能在无令牌的本机调试模式下直接连 `ws://127.0.0.1:3210/ws`。
 */
export function isTrustedOrigin(origin: string | string[] | undefined): boolean {
  const raw = Array.isArray(origin) ? origin[0] : origin;
  if (raw === undefined || raw === null) return true;
  const value = String(raw).trim();
  if (!value) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]';
}

interface RegisteredDevice {
  info: DeviceInfo;
  conn?: BridgeConnection;
}

/** 一条在线连接。 */
class BridgeConnection implements WsBridgeConnection {
  deviceId = '';
  deviceName = '';
  client = 'dsh';
  clientVersion = '';
  features: string[] = [];
  tokenId?: string;
  tokenLabel?: string;
  connectedAt?: number;
  lastSeenAt: number;
  received = 0;
  missedPongs = 0;
  registered = false;
  closed = false;

  private helloTimeout?: NodeJS.Timeout;
  private rateWindowStart = 0;
  private rateCount = 0;
  private readonly closeWaiters: Array<() => void> = [];

  constructor(
    private readonly server: WsBridgeServer,
    readonly ws: WebSocket,
    readonly remoteAddress: string,
  ) {
    this.lastSeenAt = Date.now();
    this.helloTimeout = setTimeout(() => {
      if (this.registered || this.closed) return;
      this.reject({ code: 'not_ready', message: '没有及时发送 hello' }, CLOSE_CODES.helloTimeout);
    }, server.helloTimeoutMs);
    this.helloTimeout.unref?.();
    ws.on('close', () => this.markClosed());
    ws.on('pong', () => {
      this.missedPongs = 0;
      this.lastSeenAt = Date.now();
    });
  }

  send(body: ServerFrameBody, meta?: { at?: string }): boolean {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.server.log?.warn('连接背压过大，跳过一帧', {
        deviceId: this.deviceId || undefined,
        buffered: this.ws.bufferedAmount,
      });
      return false;
    }
    try {
      this.ws.send(encodeServerFrame(body, meta));
      return true;
    } catch (error) {
      this.server.log?.warn('发送 WS 帧失败', { err: messageOf(error) });
      return false;
    }
  }

  close(code: number = CLOSE_CODES.normal, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = undefined;
    }
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  terminate(): void {
    this.closed = true;
    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = undefined;
    }
    try {
      this.ws.terminate();
    } catch {
      // 已经断了。
    }
  }

  /** 回一帧 `error` 再关闭；没有关闭码时只回错误帧。 */
  reject(error: FrameError, code?: number): void {
    this.send({ type: 'error', code: error.code, message: error.message, ...(error.ref ? { ref: error.ref } : {}) });
    if (code !== undefined) this.close(code, error.message);
  }

  notePong(): void {
    this.missedPongs = 0;
    this.lastSeenAt = Date.now();
  }

  onceClosed(cb: () => void): void {
    if (this.closed) cb();
    else this.closeWaiters.push(cb);
  }

  /** 处理一条消息；限流与超限都在这里拦。 */
  handleMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    const bytes = toBuffer(data);
    this.lastSeenAt = Date.now();
    if (!this.allowFrame()) return;
    if (isBinary) {
      this.reject({ code: 'bad_frame', message: '只接受 UTF-8 文本帧' });
      return;
    }
    if (bytes.length > MAX_FRAME_BYTES) {
      this.reject(
        { code: 'payload_too_large', message: `帧超过 ${MAX_FRAME_BYTES} 字节` },
        CLOSE_CODES.frameTooLarge,
      );
      return;
    }
    const parsed = parseClientFrameText(bytes.toString('utf8'));
    if (!parsed.ok) {
      const code = closeCodeForError(parsed.error.code);
      this.reject(parsed.error, code);
      return;
    }
    this.dispatch(parsed.frame);
  }

  /** 只有头部令牌的握手会预先带上这两个值。 */
  setPreAuth(tokenId?: string, tokenLabel?: string): void {
    if (tokenId) this.tokenId = tokenId;
    if (tokenLabel) this.tokenLabel = tokenLabel;
  }

  private dispatch(frame: ClientFrame): void {
    switch (frame.type) {
      case 'hello':
        this.handleHello(frame);
        return;
      case 'task':
        void this.handleTask(frame);
        return;
      case 'reply-result':
        this.handleReplyResult(frame);
        return;
      case 'pong':
        this.notePong();
        return;
      case 'bye':
        this.close(CLOSE_CODES.normal, frame.reason ?? 'bye');
        return;
    }
  }

  private handleHello(frame: HelloFrame): void {
    if (this.registered) {
      this.reject({ code: 'bad_frame', message: '重复的 hello' });
      return;
    }
    if (!this.tokenId) {
      if (frame.token) {
        const found = this.server.tokens.match(frame.token);
        if (!found) {
          this.reject({ code: 'unauthorized', message: '令牌无效' }, CLOSE_CODES.unauthorized);
          return;
        }
        if (!found.enabled) {
          this.reject({ code: 'unauthorized', message: '令牌已停用' }, CLOSE_CODES.revoked);
          return;
        }
        this.setPreAuth(found.record.id, found.record.label);
      } else if (!this.anonymousAllowed()) {
        this.reject({ code: 'unauthorized', message: '需要令牌' }, CLOSE_CODES.unauthorized);
        return;
      }
    }

    this.deviceId = frame.deviceId;
    this.deviceName = frame.deviceName;
    this.client = frame.client;
    this.clientVersion = frame.clientVersion;
    this.features = frame.features;
    this.connectedAt = Date.now();
    this.lastSeenAt = this.connectedAt;

    const replaced = this.server.connectionOf(this.deviceId);
    if (replaced && replaced !== this) {
      replaced.close(CLOSE_CODES.replaced, '同一设备的新连接顶掉了旧连接');
    }
    if (this.server.onlineCount(this.deviceId) >= this.server.maxDevices) {
      this.close(CLOSE_CODES.tooManyDevices, '设备数超过上限');
      return;
    }

    this.registered = true;
    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = undefined;
    }
    this.server.registerDevice(this);
    this.send({
      type: 'hello-ok',
      serverVersion: this.server.version,
      deviceId: this.deviceId,
      heartbeatSec: this.server.heartbeatSec,
      limits: { maxFrameBytes: MAX_FRAME_BYTES, maxReplyChars: MAX_REPLY_CHARS },
    });
    void Promise.resolve(this.server.hooks.onConnected(this)).catch((error: unknown) => {
      this.server.log?.warn('设备上线回调失败', { err: messageOf(error) });
    });
  }

  private async handleTask(frame: TaskFrame): Promise<void> {
    if (!this.registered) {
      this.send({ type: 'error', code: 'not_ready', message: '还没有完成 hello', ref: frame.msgId });
      return;
    }
    this.received += 1;
    this.lastSeenAt = Date.now();
    this.server.noteReceived(this);
    const cached = this.server.seenCursor(this.deviceId, frame.msgId);
    if (cached !== undefined) {
      this.send({ type: 'ack', ref: frame.msgId, cursor: cached, duplicate: true });
      return;
    }
    try {
      const result = await this.server.hooks.onTask(this, frame.note, frame.msgId);
      this.server.rememberTask(this.deviceId, frame.msgId, result.cursor);
      this.send({ type: 'ack', ref: frame.msgId, cursor: result.cursor, ...(result.duplicate ? { duplicate: true } : {}) });
    } catch (error) {
      this.server.log?.warn('任务通知落库失败', { err: messageOf(error), msgId: frame.msgId });
      this.send({ type: 'error', code: 'bad_frame', message: '任务通知落库失败', ref: frame.msgId });
    }
  }

  private handleReplyResult(frame: ReplyResultFrame): void {
    if (!this.registered) return;
    this.server.hooks.onReplyResult(this.deviceId, frame.replyId, frame.ok, frame.error);
  }

  /** 没有可用令牌、允许匿名本机且对端确实在本机时，才放行无令牌连接。 */
  private anonymousAllowed(): boolean {
    const server = this.server;
    return server.allowAnonymousLoopback
      && !server.tokens.hasEnabled()
      && isLoopbackAddress(this.remoteAddress);
  }

  private allowFrame(): boolean {
    const now = Date.now();
    if (now - this.rateWindowStart > RATE_LIMIT_WINDOW_MS) {
      this.rateWindowStart = now;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    if (this.rateCount <= RATE_LIMIT_MAX_FRAMES) return true;
    this.reject(
      { code: 'rate_limited', message: `每 ${RATE_LIMIT_WINDOW_MS / 1000} 秒最多 ${RATE_LIMIT_MAX_FRAMES} 帧` },
      CLOSE_CODES.retryLater,
    );
    return false;
  }

  private markClosed(): void {
    this.closed = true;
    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = undefined;
    }
    this.server.forget(this);
    const waiters = this.closeWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

/** `ws` 交来的 `RawData` 统一成 Buffer。 */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

export class WsBridgeServer {
  private httpServer?: Server;
  private wss?: WebSocketServer;
  private heartbeatTimer?: NodeJS.Timeout;
  private boundPort?: number;
  private boundHost = '';
  private stopping = false;

  private readonly connections = new Set<BridgeConnection>();
  private readonly devices = new Map<string, RegisteredDevice>();
  /** deviceId → msgId → 游标；断线重发靠它去重。 */
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(private readonly opts: WsBridgeServerOptions) {}

  get port(): number | undefined {
    return this.boundPort;
  }

  get listening(): boolean {
    return Boolean(this.httpServer && this.boundPort !== undefined);
  }

  get host(): string {
    return this.boundHost;
  }

  get helloTimeoutMs(): number {
    return this.opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  get heartbeatSec(): number {
    return clampHeartbeatSec(this.opts.heartbeatSec);
  }

  get maxDevices(): number {
    return clampMaxDevices(this.opts.maxDevices);
  }

  get allowAnonymousLoopback(): boolean {
    return this.opts.allowAnonymousLoopback === true;
  }

  get version(): string {
    return this.opts.version;
  }

  get tokens(): TokenStore {
    return this.opts.tokens;
  }

  get hooks(): WsBridgeHooks {
    return this.opts.hooks;
  }

  get log(): BridgeLogger | undefined {
    return this.opts.log;
  }

  /** `ws://<host>:<port>/ws`；监听 `0.0.0.0` 时照样返回。 */
  wsUrl(): string {
    const host = normalizeHost(this.opts.host);
    const port = this.boundPort ?? normalizePort(this.opts.port);
    return `ws://${urlHost(host)}:${port}${WS_PATH}`;
  }

  /** `http://<host>:<port>`；`/health` 用。 */
  baseUrl(): string {
    const host = normalizeHost(this.opts.host);
    const port = this.boundPort ?? normalizePort(this.opts.port);
    return `http://${urlHost(host)}:${port}`;
  }

  async start(): Promise<number> {
    if (this.httpServer) return this.boundPort!;
    const host = normalizeHost(this.opts.host);
    const port = normalizePort(this.opts.port);
    // 监听非回环地址却没有可用令牌：等于把入口裸露在网络上，直接拒绝启动。
    if (!isLoopbackHost(host) && !this.opts.tokens.hasEnabled()) {
      throw new Error(
        `Notify Receiver 监听 ${host}（非本机地址）时必须先在「令牌」页签里新建一个令牌：`
        + 'DSH 插件要填同一个值，否则任何人都能连进来。',
      );
    }

    const httpServer = createServer((req, res) => this.handleHttp(req, res));
    httpServer.on('clientError', (_error, socket) => {
      if ((socket as Duplex).writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: TRANSPORT_MAX_PAYLOAD });
    httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head, wss));

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          httpServer.off('listening', onListening);
          const detail = error.code === 'EADDRINUSE'
            ? `端口 ${port} 已被占用，换一个 worlds.notify-receiver.port`
            : error.code === 'EACCES'
              ? `没有权限监听端口 ${port}`
              : error.message;
          reject(new Error(`Notify Receiver 无法监听 ${host}:${port}：${detail}`));
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    } catch (error) {
      wss.close();
      httpServer.close();
      throw error;
    }

    const address = httpServer.address();
    this.boundPort = address !== null && typeof address === 'object' ? address.port : port;
    this.boundHost = host;
    this.httpServer = httpServer;
    this.wss = wss;
    this.stopping = false;
    const intervalMs = Math.max(50, Math.round(this.heartbeatSec * 1000));
    this.heartbeatTimer = setInterval(() => this.tickHeartbeat(), intervalMs);
    this.heartbeatTimer.unref?.();
    return this.boundPort;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    // 先礼后兵：发 1000 让对端知道是主动关闭，150ms 内没断的强制断。
    const conns = [...this.connections];
    for (const conn of conns) conn.close(CLOSE_CODES.normal, 'Coopanion 正在停止服务');
    if (conns.length) {
      await new Promise<void>((resolve) => {
        let left = conns.length;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => {
          for (const conn of conns) conn.terminate();
          done();
        }, 150);
        timer.unref?.();
        for (const conn of conns) {
          conn.onceClosed(() => {
            left -= 1;
            if (left <= 0) {
              clearTimeout(timer);
              done();
            }
          });
        }
      });
    }
    for (const conn of [...this.connections]) conn.terminate();
    for (const device of this.devices.values()) {
      if (device.conn) {
        device.info.online = false;
        device.conn = undefined;
      }
    }
    const wss = this.wss;
    const httpServer = this.httpServer;
    this.wss = undefined;
    this.httpServer = undefined;
    this.boundPort = undefined;
    this.devices.clear();
    this.seen.clear();
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }

  /** 在线设备数；`exclude` 用于顶号前先扣掉自己。 */
  onlineCount(exclude?: string): number {
    let count = 0;
    for (const [deviceId, device] of this.devices) {
      if (deviceId === exclude) continue;
      if (device.info.online && device.conn && !device.conn.closed) count += 1;
    }
    return count;
  }

  isOnline(deviceId: string): boolean {
    return Boolean(this.connectionOf(deviceId));
  }

  /** 在线/离线设备快照：在线的排前面，其余按最近活动倒序。 */
  devicesSnapshot(): DeviceInfo[] {
    return [...this.devices.values()]
      .map((device) => ({ ...device.info, online: Boolean(device.conn && !device.conn.closed) }))
      .sort((left, right) => {
        if (left.online !== right.online) return left.online ? -1 : 1;
        return right.lastSeenAt - left.lastSeenAt;
      });
  }

  deviceInfo(deviceId: string): DeviceInfo | undefined {
    const device = this.devices.get(deviceId);
    return device ? { ...device.info, online: Boolean(device.conn && !device.conn.closed) } : undefined;
  }

  /** 给某台设备发一帧；离线、不可写或背压过高时返回 false。 */
  sendTo(deviceId: string, body: ServerFrameBody, meta?: { at?: string }): boolean {
    const conn = this.connectionOf(deviceId);
    if (!conn) return false;
    return conn.send(body, meta);
  }

  /** 发一条回传消息；文本按协议上限截断。 */
  sendReply(
    deviceId: string,
    reply: { replyId: string; taskId: string; sessionId: string; text: string; at: string },
  ): boolean {
    return this.sendTo(deviceId, {
      type: 'reply',
      replyId: reply.replyId,
      taskId: reply.taskId,
      sessionId: reply.sessionId,
      text: reply.text.slice(0, MAX_REPLY_CHARS),
    }, { at: reply.at });
  }

  /** 面板「断开」：1013 表示稍后重连，DSH 会按退避自己回来。 */
  kick(deviceId: string): boolean {
    const conn = this.connectionOf(deviceId);
    if (!conn) return false;
    conn.close(CLOSE_CODES.retryLater, '被 Coopanion 断开');
    return true;
  }

  /** 令牌被禁用/删除/轮换：用它认证的连接立刻 4403。 */
  closeTokenConnections(tokenId: string): number {
    let closed = 0;
    for (const conn of [...this.connections]) {
      if (conn.tokenId !== tokenId) continue;
      conn.close(CLOSE_CODES.revoked, '令牌已停用或删除');
      closed += 1;
    }
    return closed;
  }

  /** 关闭全部连接（World 停机或吊销全部令牌）。 */
  closeAll(code: number, reason: string): number {
    let closed = 0;
    for (const conn of [...this.connections]) {
      conn.close(code, reason);
      closed += 1;
    }
    return closed;
  }

  /** 已注册设备里同 `deviceId` 的当前连接。 */
  connectionOf(deviceId: string): BridgeConnection | undefined {
    const device = this.devices.get(deviceId);
    if (!device?.conn || device.conn.closed) return undefined;
    return device.conn;
  }

  registerDevice(conn: BridgeConnection): void {
    const info: DeviceInfo = {
      deviceId: conn.deviceId,
      deviceName: conn.deviceName,
      client: conn.client,
      clientVersion: conn.clientVersion,
      tokenId: conn.tokenId,
      tokenLabel: conn.tokenLabel,
      connectedAt: conn.connectedAt ?? Date.now(),
      lastSeenAt: conn.lastSeenAt,
      received: conn.received,
      online: true,
      remoteAddress: conn.remoteAddress || undefined,
    };
    this.devices.set(conn.deviceId, { info, conn });
  }

  noteReceived(conn: BridgeConnection): void {
    const device = this.devices.get(conn.deviceId);
    if (!device) return;
    device.info.received = conn.received;
    device.info.lastSeenAt = conn.lastSeenAt;
  }

  seenCursor(deviceId: string, msgId: string): number | undefined {
    return this.seen.get(deviceId)?.get(msgId);
  }

  rememberTask(deviceId: string, msgId: string, cursor: number): void {
    let map = this.seen.get(deviceId);
    if (!map) {
      map = new Map<string, number>();
      this.seen.set(deviceId, map);
    }
    map.set(msgId, cursor);
    while (map.size > SEEN_MSG_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  /** 连接关闭时从注册表摘掉；只处理「当前连接」这一条，顶号时不会误标离线。 */
  forget(conn: BridgeConnection): void {
    this.connections.delete(conn);
    const device = this.devices.get(conn.deviceId);
    if (!device || device.conn !== conn) return;
    device.conn = undefined;
    device.info.online = false;
    device.info.lastSeenAt = conn.lastSeenAt;
    device.info.received = conn.received;
    if (this.stopping) return;
    void Promise.resolve(this.hooks.onDisconnected({ ...device.info })).catch((error: unknown) => {
      this.log?.warn('设备下线回调失败', { err: messageOf(error) });
    });
  }

  /** 心跳：连续 2 次没有 pong 就断开；顺带让 World 扫一遍离线回传的 TTL。 */
  tickHeartbeat(): void {
    if (!this.listening) return;
    const now = Date.now();
    for (const conn of [...this.connections]) {
      if (!conn.registered || conn.closed) continue;
      if (conn.missedPongs >= 2) {
        conn.close(CLOSE_CODES.retryLater, '心跳超时');
        continue;
      }
      conn.missedPongs += 1;
      conn.send({ type: 'ping', ts: new Date(now).toISOString() });
      try {
        conn.ws.ping();
      } catch {
        // 原生 ping 只是双保险，失败不影响应用层心跳。
      }
    }
    try {
      this.hooks.onTick?.();
    } catch (error) {
      this.log?.warn('心跳回调失败', { err: messageOf(error) });
    }
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ): void {
    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // 坏 URL 当作不认识的路径。
    }
    if (path !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // 跨站防护：先升级再以 4403 关闭，客户端才看得到关闭码。
    if (!isTrustedOrigin(req.headers.origin)) {
      this.log?.warn('拒绝不可信的 Origin', { origin: String(req.headers.origin) });
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_CODES.revoked, 'Origin 不受信');
      });
      return;
    }

    const bearer = readBearerToken(req.headers.authorization);
    const auth: { tokenId?: string; tokenLabel?: string; error?: FrameError; code?: number } = {};
    if (bearer) {
      const found = this.opts.tokens.match(bearer);
      if (!found) {
        auth.error = { code: 'unauthorized', message: '令牌无效' };
        auth.code = CLOSE_CODES.unauthorized;
      } else if (!found.enabled) {
        auth.error = { code: 'unauthorized', message: '令牌已停用' };
        auth.code = CLOSE_CODES.revoked;
      } else {
        auth.tokenId = found.record.id;
        auth.tokenLabel = found.record.label;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new BridgeConnection(this, ws, req.socket.remoteAddress ?? '');
      this.connections.add(conn);
      ws.on('message', (data: RawData, isBinary: boolean) => conn.handleMessage(data, isBinary));
      ws.on('error', (error: Error) => {
        this.log?.warn('WS 连接出错', { err: messageOf(error) });
      });
      if (auth.error) {
        conn.reject(auth.error, auth.code);
        return;
      }
      conn.setPreAuth(auth.tokenId, auth.tokenLabel);
    });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // 坏 URL 走 404。
    }
    if (path === HEALTH_PATH) {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        this.sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      this.sendJson(res, 200, {
        ok: true,
        world: 'notify-receiver',
        protocol: PROTOCOL_NAME,
        listening: this.listening,
        onlineDevices: this.onlineCount(),
      });
      return;
    }
    if (path === WS_PATH) {
      res.setHeader('upgrade', 'websocket');
      this.sendJson(res, 426, { ok: false, error: 'upgrade required' });
      return;
    }
    this.sendJson(res, 404, { ok: false, error: 'not found' });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(json);
  }
}
