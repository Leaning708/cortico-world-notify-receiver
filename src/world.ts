/**
 * Notify Receiver World：在 Coopanion 一侧开一个 WebSocket 服务端，DSH 插件主动连过来。
 *
 * 分工：`ws-server.ts` 管连接与帧搬运，本文件管事件投递、待回复绑定、离线回传队列与面板。
 * 正文只陈述 DSH 报来的事实，行为由 `ENV_PROMPT.md` 说明。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { configValues, sanitizeConfigPatch } from './config-save.ts';
import type { DeviceInText, NotifyReceiverConfigSection } from './config.ts';
import { formatDuration, renderTaskEventText, type DshTaskNote } from './note.ts';
import { matchReplyText, parseKeywords, replyHintText } from './reply-policy.ts';
import { CLOSE_CODES, HEALTH_PATH, MAX_REPLY_CHARS, PROTOCOL_NAME, WS_PATH } from './protocol.ts';
import { TokenStore, type GeneratedToken, type TokenView } from './tokens.ts';
import {
  WsBridgeServer,
  clampHeartbeatSec,
  clampMaxDevices,
  normalizeHost,
  normalizePort,
  type DeviceInfo,
  type WsBridgeConnection,
  type WsBridgeServerOptions,
} from './ws-server.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 一条回传消息最多重发几次（含首次发送）。 */
export const MAX_REPLY_ATTEMPTS = 3;
/** `reply-result` 失败后隔多久重发。 */
export const REPLY_RETRY_MS = 250;
/** 设备离线时回传最多保留这么久（10 分钟）；到期记一条 `dsh-notify.reply-failed`。固定值，不再可配。 */
export const OFFLINE_REPLY_TTL_MS = 600_000;
/** 当前包版本；`hello-ok.serverVersion` 与面板显示用它。 */
export const SERVER_VERSION = '0.3.3';

export interface NotifyReceiverWorldOptions {
  /** `worlds.notify-receiver` 的活引用；host/port 在 start() 时读取。 */
  cfg: NotifyReceiverConfigSection;
  timezone: string;
  /** `<dataDir>`；令牌表放在 `<dataDir>/worlds/notify-receiver/tokens.json`。 */
  dataDir: string;
  /** 面板 `config.save` 的写回通道：`WorldContext.persist`。 */
  persist: (patch: Partial<NotifyReceiverConfigSection>) => void;
}

/** 声明里的工具；`tools()` 补 handler，describe 也从这里拼。 */
export const NOTIFY_RECEIVER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'dsh_notify_status',
    description:
      'Report the Notify Receiver WebSocket server: whether it is listening, the ws:// URL DSH should connect to, '
      + 'how many tokens and devices there are, and what replies are pending or failed.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 一条通知开启的待回复绑定；绑定发来这条通知的设备。
 *
 * 没有过期时间、没有转发条数上限、没有冷却：一直有效到被下一条通知替换、
 * 设备断开或 World 停止。每成功转发一条就推进 `cursor`，同一条不会转两次。
 */
interface PendingReply {
  /** 这条通知来自哪台设备；命中后回传只走这条连接。 */
  deviceId: string;
  deviceName: string;
  sessionId: string;
  /** 会话标题，状态工具里显示用。 */
  sessionTitle: string;
  /** 通知的 `msgId`，回传帧里作为 `taskId`。 */
  taskId: string;
  /** 通知 id，与消息游标一起拼 `replyId`。 */
  notificationId: string;
  /** 通知事件落库时的游标；只读它之后的消息。 */
  cursor: number;
  /** 正在按顺序转发，避免重入。 */
  forwarding: boolean;
}

/** 待送达的回传消息；设备离线时留在队列里，重连后补发。 */
interface QueuedReply {
  replyId: string;
  taskId: string;
  deviceId: string;
  deviceName: string;
  sessionId: string;
  text: string;
  /** 用户说话的时刻（ISO8601），回传帧的 `at`。 */
  at: string;
  /** 已发送次数（含首发）。 */
  attempts: number;
  queuedAt: number;
  lastAttemptAt?: number;
  timer?: NodeJS.Timeout;
}

/** 控制台 World 把用户输入的原文放在 `meta.body`；桌宠 World 放在 `meta.text`。 */
function eventBody(event: EventEnvelope): string {
  for (const value of [event.meta?.text, event.meta?.body]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const text = typeof event.text === 'string' ? event.text : '';
  const separator = text.lastIndexOf(': ');
  return (separator >= 0 ? text.slice(separator + 2) : text).trim();
}

/** Coopanion 当前使用的聊天通道：控制台页是 console.message，桌宠是 desktop-pet.message。 */
const USER_MESSAGE_TYPES = new Set(['console.message', 'desktop-pet.message']);

function isUserMessage(event: EventEnvelope): boolean {
  return USER_MESSAGE_TYPES.has(event.type) && event.source !== 'notify-receiver';
}

/** 从 invoke 的 args 里读一个字符串参数；也接受直接传字符串。 */
function readArg(args: readonly unknown[], key: string): string {
  const first = args[0];
  if (typeof first === 'string') return first.trim();
  if (typeof first === 'object' && first !== null) {
    const value = (first as Record<string, unknown>)[key];
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

/** 从 invoke 的 args 里读一个布尔参数；缺省为 `fallback`。 */
function readBoolArg(args: readonly unknown[], key: string, fallback: boolean): boolean {
  const first = args[0];
  if (typeof first === 'boolean') return first;
  if (typeof first === 'object' && first !== null) {
    const value = (first as Record<string, unknown>)[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

export class NotifyReceiverWorld implements World {
  readonly id = 'notify-receiver';

  private host?: WorldHost;
  private server?: WsBridgeServer;
  private boundPort?: number;
  private readonly tokens: TokenStore;
  private received = 0;
  private lastAt?: string;
  private lastError?: string;
  private pending?: PendingReply;
  private forwarded = 0;
  private lastReplyAt?: string;
  private lastReplyError?: string;
  /**
   * 待送达的回传消息。放在世界一层而不是挂在待回复绑定上：新通知会替换旧绑定，
   * 但已经排队的回传不该跟着丢。
   */
  private readonly replies = new Map<string, QueuedReply>();

  constructor(private readonly opts: NotifyReceiverWorldOptions) {
    this.tokens = TokenStore.forDataDir(opts.dataDir);
  }

  /** 环境提示词模板没有占位符；返回 `{}` 表示整份原样使用。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [
      {
        ...NOTIFY_RECEIVER_TOOL_DECLS[0],
        handler: async () => this.statusText(),
      },
    ];
  }

  webUi(): WorldWebUiDecl {
    const online = this.server?.onlineCount() ?? 0;
    const enabledTokens = this.tokens.enabledCount();
    return {
      lamps: [
        {
          label: '服务器',
          state: this.server ? 'online' : this.lastError ? 'error' : 'offline',
          hint: this.server ? `${this.wsUrl()}（监听中）` : (this.lastError ?? '未启动'),
        },
        {
          label: `客户端 ${online}`,
          state: online > 0 ? 'online' : 'offline',
          hint: online > 0 ? `${online} 台 DSH 在线` : '还没有 DSH 连上',
        },
      ],
      badges: [
        { label: '在线设备', value: online, tone: online > 0 ? 'on' : 'off' },
        { label: '可用令牌', value: enabledTokens, tone: enabledTokens > 0 ? 'on' : 'off' },
      ],
      panels: [
        { id: 'service', title: '服务', description: '发布地址、端口、心跳、设备上限与上下线提示。' },
        { id: 'tokens', title: '令牌', description: 'DSH 连入用的令牌；明文只显示一次。' },
        { id: 'devices', title: '设备', description: '在线/离线设备，可断开某台。' },
        { id: 'reply', title: '回传规则', description: '关键字匹配与转发；关键字留空表示不转发。' },
      ],
      invoke: async (panel, method, args = []) => {
        void panel;
        return this.handleInvoke(method, args);
      },
      promptDocs: [
        {
          key: 'worlds.notify-receiver.envPrompt',
          title: '环境提示词',
          description: 'Notify Receiver 进 system 前缀的那一段：收到通知和待回复时怎么反应。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
      storage: [
        {
          key: 'tokens',
          label: 'Notify Receiver 令牌',
          kind: 'disk',
          location: this.tokens.path,
          danger: true,
          note: '清除等于吊销全部令牌：正在连的设备会立刻断开，DSH 侧要换新的明文。',
          stat: () => `${this.tokens.count()} 个令牌（${this.tokens.enabledCount()} 个启用）`,
          clear: () => {
            const count = this.tokens.revokeAll();
            const closed = this.server?.closeAll(CLOSE_CODES.revoked, '令牌已全部吊销') ?? 0;
            return `已吊销 ${count} 个令牌，断开 ${closed} 条连接。`;
          },
        },
      ],
    };
  }

  /** 绑定的端口；端口填 0 时由系统分配，测试与状态工具读它。 */
  get port(): number | undefined {
    return this.boundPort;
  }

  /** DSH 插件要连的完整地址。 */
  wsUrl(): string {
    const host = normalizeHost(this.opts.cfg.host);
    const port = this.boundPort ?? normalizePort(this.opts.cfg.port);
    const shown = host.includes(':') ? `[${host}]` : host;
    return `ws://${shown}:${port}${WS_PATH}`;
  }

  baseUrl(): string {
    const host = normalizeHost(this.opts.cfg.host);
    const port = this.boundPort ?? normalizePort(this.opts.cfg.port);
    const shown = host.includes(':') ? `[${host}]` : host;
    return `http://${shown}:${port}`;
  }

  async start(host: WorldHost): Promise<void> {
    if (this.server) return;
    this.host = host;
    this.lastError = undefined;
    const options: WsBridgeServerOptions = {
      host: this.opts.cfg.host,
      port: this.opts.cfg.port,
      heartbeatSec: clampHeartbeatSec(this.opts.cfg.heartbeatSec),
      maxDevices: clampMaxDevices(this.opts.cfg.maxDevices),
      allowAnonymousLoopback: this.opts.cfg.allowAnonymousLoopback === true,
      tokens: this.tokens,
      version: SERVER_VERSION,
      log: host.log,
      hooks: {
        onTask: async (conn, note, msgId) => this.handleTask(conn, note, msgId),
        onConnected: async (conn) => {
          await this.announceConnection(conn);
          this.flushReplies(conn.deviceId);
        },
        onDisconnected: async (device) => {
          this.dropPendingFor(device.deviceId);
          await this.announceDisconnection(device);
        },
        onReplyResult: (deviceId, replyId, ok, error) => this.handleReplyResult(deviceId, replyId, ok, error),
        onTick: () => this.sweepOfflineReplies(),
      },
    };
    const server = new WsBridgeServer(options);
    try {
      await server.start();
    } catch (error) {
      this.lastError = messageOf(error);
      this.host = undefined;
      throw error;
    }
    this.server = server;
    this.boundPort = server.port;
    host.log.info('Notify Receiver WS 服务已启动', {
      url: this.wsUrl(),
      bind: `${normalizeHost(this.opts.cfg.host)}:${this.boundPort}`,
    });

    // 记录监听状态但不投递：启动本身不该唤醒 Coo；事件库里能看到服务何时起来。
    try {
      await host.pushEvent(
        {
          type: 'dsh-notify.listening',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'internal',
          senderKey: this.id,
          text: `Notify Receiver 已在 ${this.wsUrl()} 监听，健康检查 ${HEALTH_PATH}。`,
          meta: { bind: `${normalizeHost(this.opts.cfg.host)}:${this.boundPort}`, protocol: PROTOCOL_NAME },
        },
        { deliver: false },
      );
    } catch (error) {
      host.log.warn('Notify Receiver 已监听，但监听状态事件写入失败', { err: messageOf(error) });
    }
  }

  async stop(): Promise<void> {
    this.pending = undefined;
    for (const entry of this.replies.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.replies.clear();
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    this.host = undefined;
    if (server) await server.stop();
  }

  /** 面板与状态工具共用的快照；不含令牌明文与哈希。 */
  private panelState() {
    const server = this.server;
    return {
      tokenSet: this.tokens.enabledCount() > 0,
      // 没有 ConfigGroup 兜底了：缺字段时补 NOTIFY_RECEIVER_DEFAULTS，面板总能画出完整表单。
      values: configValues(this.opts.cfg),
      tokens: this.tokens.list(),
      devices: this.devicesWithQueue(),
      status: {
        listening: Boolean(server),
        wsUrl: this.wsUrl(),
        port: this.port,
        onlineDevices: server?.onlineCount() ?? 0,
        totalTokens: this.tokens.count(),
        enabledTokens: this.tokens.enabledCount(),
        tokenError: this.tokens.error,
        lastError: this.lastError,
      },
    };
  }

  private devicesWithQueue(): Array<DeviceInfo & { pendingReplies: number }> {
    const devices = this.server?.devicesSnapshot() ?? [];
    return devices.map((device) => ({ ...device, pendingReplies: this.pendingReplyCount(device.deviceId) }));
  }

  private async handleInvoke(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'state':
        return this.panelState();
      case 'config.save':
        return this.invokeSaveConfig(args);
      case 'tokens.add':
        return this.invokeAddToken(args);
      case 'tokens.remove':
        return this.invokeRemoveToken(args);
      case 'tokens.setEnabled':
        return this.invokeSetTokenEnabled(args);
      case 'tokens.rotate':
        return this.invokeRotateToken(args);
      case 'devices.kick':
        return this.invokeKickDevice(args);
      default:
        throw new Error(`未知的 Notify Receiver 面板方法：${method}`);
    }
  }

  /**
   * 面板保存：校验/夹取后写回 `worlds.notify-receiver`。
   * host/port 改的是 `start()` 时读的绑定参数，返回 restartRequired 让面板提示重启 World。
   */
  private invokeSaveConfig(args: unknown[]): {
    values: ReturnType<typeof configValues>;
    restartRequired: boolean;
  } {
    const { patch, restartRequired } = sanitizeConfigPatch(args[0], {
      host: this.opts.cfg.host,
      port: this.opts.cfg.port,
    });
    this.opts.persist(patch);
    this.host?.log.info('Notify Receiver 配置已更新', {
      keys: Object.keys(patch),
      restartRequired,
    });
    return { values: configValues(this.opts.cfg), restartRequired };
  }

  /** 新建令牌：返回明文一次，同时带上最新列表供面板重绘。 */
  private invokeAddToken(args: unknown[]): { token: string; id: string; prefix: string; label: string; tokens: TokenView[] } {
    const label = readArg(args, 'label') || '未命名';
    const generated: GeneratedToken = this.tokens.add(label);
    this.host?.log.info('已新建 Notify Receiver 令牌', { prefix: generated.prefix, label: generated.label });
    return { ...generated, tokens: this.tokens.list() };
  }

  private invokeRemoveToken(args: unknown[]): { removed: boolean; id: string; tokens: TokenView[] } {
    const id = readArg(args, 'id');
    if (!id) throw new Error('缺少令牌 id');
    const removed = this.tokens.remove(id);
    if (removed) {
      const closed = this.server?.closeTokenConnections(id) ?? 0;
      this.host?.log.info('已删除 Notify Receiver 令牌', { id, closed });
    }
    return { removed, id, tokens: this.tokens.list() };
  }

  private invokeSetTokenEnabled(args: unknown[]): { updated: boolean; id: string; enabled: boolean; tokens: TokenView[] } {
    const id = readArg(args, 'id');
    if (!id) throw new Error('缺少令牌 id');
    const enabled = readBoolArg(args, 'enabled', true);
    const record = this.tokens.setEnabled(id, enabled);
    if (!record) throw new Error(`令牌 ${id} 不存在`);
    if (!enabled) this.server?.closeTokenConnections(id);
    return { updated: true, id, enabled: record.enabled, tokens: this.tokens.list() };
  }

  private invokeRotateToken(args: unknown[]): { token: string; id: string; prefix: string; label: string; tokens: TokenView[] } {
    const id = readArg(args, 'id');
    if (!id) throw new Error('缺少令牌 id');
    const generated = this.tokens.rotate(id);
    if (!generated) throw new Error(`令牌 ${id} 不存在`);
    const closed = this.server?.closeTokenConnections(id) ?? 0;
    this.host?.log.info('已轮换 Notify Receiver 令牌', { oldId: id, prefix: generated.prefix, closed });
    return { ...generated, tokens: this.tokens.list() };
  }

  private invokeKickDevice(args: unknown[]): { kicked: boolean; deviceId: string; devices: Array<DeviceInfo & { pendingReplies: number }> } {
    const deviceId = readArg(args, 'deviceId');
    if (!deviceId) throw new Error('缺少设备 deviceId');
    const kicked = this.server?.kick(deviceId) ?? false;
    if (kicked) this.host?.log.info('已断开一台 DSH 设备', { deviceId });
    return { kicked, deviceId, devices: this.devicesWithQueue() };
  }

  /** 一条 task 落库：事件源是这条连接对应的设备。 */
  private async handleTask(
    conn: WsBridgeConnection,
    note: DshTaskNote,
    msgId: string,
  ): Promise<{ cursor: number; duplicate?: boolean }> {
    const withDevice: DshTaskNote = { ...note, device: conn.deviceName || note.device };
    const envelope = await this.pushTask(withDevice, conn.deviceId);
    this.received += 1;
    this.lastAt = envelope.ts;
    this.openReplyWindow({
      note: withDevice,
      cursor: envelope.cursor,
      deviceId: conn.deviceId,
      deviceName: conn.deviceName,
      taskId: msgId,
    });
    return { cursor: envelope.cursor };
  }

  /** 把一条通知作为外部事件投给主循环；`flush` 表示立刻投递、不必等合批窗口。 */
  private async pushTask(note: DshTaskNote, deviceId: string): Promise<EventEnvelope> {
    const host = this.host;
    if (!host) throw new Error('Notify Receiver 已停止');
    const meta: Record<string, unknown> = { status: note.status, deviceId };
    if (note.device) meta.device = note.device;
    if (note.sessionId) meta.sessionId = note.sessionId;
    if (note.title) meta.title = note.title;
    if (note.turn !== undefined) meta.turn = note.turn;
    if (note.durationMs !== undefined) meta.durationMs = note.durationMs;
    if (note.cwd) meta.cwd = note.cwd;
    if (note.reportedAt) meta.reportedAt = note.reportedAt;
    const body = renderTaskEventText(note, {
      deviceInText: this.deviceInText(),
      knownDevices: this.knownDeviceCount(),
    });
    return host.pushEvent(
      {
        type: 'dsh-notify.task',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'external',
        senderKey: `dsh:${deviceId}`,
        text: `${body}${this.replyHint(note)}`,
        meta,
      },
      { trigger: 'flush' },
    );
  }

  private deviceInText(): DeviceInText {
    const value = this.opts.cfg.deviceInText;
    return value === 'always' || value === 'never' || value === 'auto' ? value : 'auto';
  }

  private knownDeviceCount(): number {
    return this.server?.devicesSnapshot().length ?? 0;
  }

  /**
   * 主循环一轮结束时扫描待回复：从 `cursor` 之后按游标顺序找出所有关键字命中的用户消息，
   * 全部转发；每成功一条推进 cursor，所以同一条不会转两次。
   *
   * 待回复本身不在这里失效：它一直有效到被下一条通知替换、设备断开或 World 停止。
   */
  onTurnEnded(): void {
    const pending = this.pending;
    if (!pending || pending.forwarding) return;
    const host = this.host;
    if (!host) return;

    const events = host.store.range({ fromCursor: pending.cursor + 1 });
    const matches: Array<{ event: EventEnvelope; text: string }> = [];
    for (const event of [...events].sort((left, right) => left.cursor - right.cursor)) {
      if (!isUserMessage(event)) continue;
      const raw = eventBody(event);
      if (!raw) continue;
      const match = matchReplyText(raw, this.opts.cfg);
      if (!match.matched || !match.text) continue;
      matches.push({ event, text: match.text });
    }
    if (matches.length === 0) return;

    pending.forwarding = true;
    void this.forwardMatches(pending, matches);
  }

  /** 设备断开时丢掉绑定在它上面的待回复：不能再往一条断开的连接转发。 */
  private dropPendingFor(deviceId: string): void {
    if (this.pending?.deviceId === deviceId) this.pending = undefined;
  }

  /**
   * 建立待回复绑定：有会话 id、设备在线、关键字非空才建；completed 与 failed 一样。
   * 任何一条通知都会替换上一条待回复（新会话 / 新 cursor）。
   */
  private openReplyWindow(input: {
    note: DshTaskNote;
    cursor: number;
    deviceId: string;
    deviceName: string;
    taskId: string;
  }): void {
    const cfg = this.opts.cfg;
    const { note } = input;
    if (!note.sessionId || !input.deviceId
      || parseKeywords(cfg.replyKeywords).length === 0
      || !(this.server?.isOnline(input.deviceId) ?? false)) {
      this.pending = undefined;
      return;
    }

    this.pending = {
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      sessionId: note.sessionId,
      sessionTitle: note.title,
      taskId: input.taskId,
      notificationId: randomUUID(),
      cursor: input.cursor,
      forwarding: false,
    };
  }

  /** 事件正文里告诉 Coo 回复规则；没有会话 id 或关键字留空（关闭回传）时不加。 */
  private replyHint(note: DshTaskNote): string {
    if (!note.sessionId) return '';
    return replyHintText(this.opts.cfg);
  }

  /** 按游标顺序逐条排队；设备在线就直接发，离线留在队列等重连。 */
  private async forwardMatches(
    pending: PendingReply,
    matches: Array<{ event: EventEnvelope; text: string }>,
  ): Promise<void> {
    try {
      for (const match of matches) {
        // 转发期间若来了新通知，旧绑定已被替换：停止，新绑定会从自己的游标重新扫。
        if (this.pending !== pending) break;
        const replyId = `${pending.notificationId}:${match.event.cursor}`;
        const entry = this.queueReply(pending, match.text, replyId);
        pending.cursor = match.event.cursor;
        this.forwarded += 1;
        this.lastReplyAt = nowIso(this.opts.timezone);
        this.host?.log.info('已把用户回复转给 DSH', {
          deviceId: pending.deviceId,
          sessionId: pending.sessionId,
          chars: entry.text.length,
          replyId,
          online: this.server?.isOnline(pending.deviceId) ?? false,
        });
        await this.pushReplied(pending, entry);
      }
    } finally {
      pending.forwarding = false;
    }
  }

  /** 入队并尝试发送；返回队列项，离线时 `attempts` 保持 0。 */
  private queueReply(pending: PendingReply, text: string, replyId: string): QueuedReply {
    const entry: QueuedReply = {
      replyId,
      taskId: pending.taskId,
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      sessionId: pending.sessionId,
      text: text.slice(0, MAX_REPLY_CHARS),
      at: nowIso(this.opts.timezone),
      attempts: 0,
      queuedAt: Date.now(),
    };
    this.replies.set(replyId, entry);
    this.deliverReply(entry);
    return entry;
  }

  /** 发一次；离线、不可写或已达上限时保留在队列里。 */
  private deliverReply(entry: QueuedReply): void {
    const server = this.server;
    if (!server) return;
    if (entry.attempts >= MAX_REPLY_ATTEMPTS) return;
    if (!server.isOnline(entry.deviceId)) return;
    const sent = server.sendReply(entry.deviceId, {
      replyId: entry.replyId,
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      text: entry.text,
      at: entry.at,
    });
    if (!sent) {
      this.lastReplyError = '回传没能发出：连接暂不可写';
      return;
    }
    entry.attempts += 1;
    entry.lastAttemptAt = Date.now();
  }

  /** DSH 回的 `reply-result`：成功出队；失败重试，最多 3 次后记 `reply-failed`。 */
  private handleReplyResult(deviceId: string, replyId: string, ok: boolean, error?: string): void {
    const entry = this.replies.get(replyId);
    if (!entry) return;
    if (ok) {
      this.replies.delete(replyId);
      this.lastReplyError = undefined;
      return;
    }
    this.lastReplyError = error ? `回传失败：${error}` : '回传失败：DSH 没有注入这条消息';
    this.host?.log.warn('DSH 回传失败', { deviceId, replyId, attempts: entry.attempts, error });
    if (entry.attempts >= MAX_REPLY_ATTEMPTS) {
      this.replies.delete(replyId);
      void this.pushReplyFailed(entry, this.lastReplyError);
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    const timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.replies.get(replyId) !== entry) return;
      this.deliverReply(entry);
    }, REPLY_RETRY_MS);
    timer.unref?.();
    entry.timer = timer;
  }

  /**
   * 设备重新连上时补发队列里的回传：按入队顺序逐条发，TTL 已过的记 `reply-failed`。
   */
  flushReplies(deviceId: string): void {
    const now = Date.now();
    const ttl = OFFLINE_REPLY_TTL_MS;
    const entries = [...this.replies.values()]
      .filter((entry) => entry.deviceId === deviceId)
      .sort((left, right) => left.queuedAt - right.queuedAt);
    for (const entry of entries) {
      if (this.replies.get(entry.replyId) !== entry) continue;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      if (now - entry.queuedAt >= ttl) {
        this.replies.delete(entry.replyId);
        void this.pushReplyFailed(entry, '设备离线超时');
        continue;
      }
      this.deliverReply(entry);
    }
  }

  /**
   * 离线回传扫描：TTL 到期的记 `reply-failed`；在线但发送失败的补一次。
   * 由 `ws-server` 的心跳触发；测试也直接调它。
   */
  sweepOfflineReplies(): void {
    const server = this.server;
    if (!server) return;
    const now = Date.now();
    const ttl = OFFLINE_REPLY_TTL_MS;
    for (const entry of [...this.replies.values()]) {
      const online = server.isOnline(entry.deviceId);
      if (!online) {
        if (now - entry.queuedAt >= ttl) {
          this.replies.delete(entry.replyId);
          void this.pushReplyFailed(entry, '设备离线超时');
        }
        continue;
      }
      if (entry.timer) continue;
      if (entry.attempts >= MAX_REPLY_ATTEMPTS) continue;
      const last = entry.lastAttemptAt ?? (entry.queuedAt - REPLY_RETRY_MS);
      if (now - last >= REPLY_RETRY_MS * 2) this.deliverReply(entry);
    }
  }

  private pendingReplyCount(deviceId: string): number {
    let count = 0;
    for (const entry of this.replies.values()) {
      if (entry.deviceId === deviceId) count += 1;
    }
    return count;
  }

  private async pushReplied(pending: PendingReply, entry: QueuedReply): Promise<void> {
    const queued = entry.attempts === 0;
    try {
      await this.host?.pushEvent(
        {
          type: 'dsh-notify.replied',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'internal',
          senderKey: this.id,
          text: `已把用户回复转给 DSH（设备「${pending.deviceName}」，会话 ${pending.sessionId}，`
            + `${entry.text.length} 字${queued ? '，设备离线，已排队' : ''}）。`,
          meta: {
            sessionId: pending.sessionId,
            notificationId: pending.notificationId,
            replyId: entry.replyId,
            deviceId: pending.deviceId,
            queued,
          },
        },
        { deliver: false },
      );
    } catch (error) {
      this.host?.log.warn('回传成功，但回传状态事件写入失败', { err: messageOf(error) });
    }
  }

  private async pushReplyFailed(entry: QueuedReply, reason: string): Promise<void> {
    try {
      await this.host?.pushEvent(
        {
          type: 'dsh-notify.reply-failed',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'internal',
          senderKey: this.id,
          text: `回传失败：给设备「${entry.deviceName}」的回复没有送达（${reason}，已尝试 ${entry.attempts} 次）。`,
          meta: {
            deviceId: entry.deviceId,
            deviceName: entry.deviceName,
            sessionId: entry.sessionId,
            replyId: entry.replyId,
            attempts: entry.attempts,
            reason,
          },
        },
        { deliver: false },
      );
    } catch (error) {
      this.host?.log.warn('回传失败事件写入失败', { err: messageOf(error) });
    }
  }

  /** 设备上线/下线：按 `announceConnections` 决定是否让 Coo 说一句。 */
  private async announceConnection(conn: WsBridgeConnection): Promise<void> {
    const deliver = this.opts.cfg.announceConnections === true;
    const detail = [conn.client, conn.clientVersion].filter(Boolean).join(' ');
    const tokenPart = conn.tokenLabel ? `｜令牌「${conn.tokenLabel}」` : '';
    await this.pushConnectionEvent('connected', {
      deviceId: conn.deviceId,
      deviceName: conn.deviceName,
      text: `DSH 设备「${conn.deviceName}」已连上（${detail || 'dsh'}${tokenPart}）。`,
      meta: {
        deviceId: conn.deviceId,
        deviceName: conn.deviceName,
        client: conn.client,
        clientVersion: conn.clientVersion,
        tokenLabel: conn.tokenLabel,
      },
      deliver,
    });
  }

  private async announceDisconnection(device: DeviceInfo): Promise<void> {
    const deliver = this.opts.cfg.announceConnections === true;
    await this.pushConnectionEvent('disconnected', {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      text: `DSH 设备「${device.deviceName}」已断开。`,
      meta: {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        client: device.client,
        clientVersion: device.clientVersion,
        tokenLabel: device.tokenLabel,
      },
      deliver,
    });
  }

  private async pushConnectionEvent(
    kind: 'connected' | 'disconnected',
    input: {
      deviceId: string;
      deviceName: string;
      text: string;
      meta: Record<string, unknown>;
      deliver: boolean;
    },
  ): Promise<void> {
    try {
      await this.host?.pushEvent(
        {
          type: `dsh-notify.${kind}`,
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'internal',
          senderKey: `dsh:${input.deviceId}`,
          text: input.text,
          meta: input.meta,
        },
        { deliver: input.deliver },
      );
    } catch (error) {
      this.host?.log.warn(`设备${kind === 'connected' ? '上线' : '下线'}事件写入失败`, {
        err: messageOf(error),
      });
    }
  }

  private statusText(): string {
    const cfg = this.opts.cfg;
    const server = this.server;
    const enabledTokens = this.tokens.enabledCount();
    const devices = this.server?.devicesSnapshot() ?? [];
    const lines: string[] = [];
    lines.push(`接收端：${server ? `${this.wsUrl()}（监听中）` : '未启动'}`);
    lines.push(`令牌：${this.tokens.count()} 个（${enabledTokens} 个启用）`);
    lines.push(`设备：${server?.onlineCount() ?? 0} 在线`);
    for (const device of devices) lines.push(`  · ${this.describeDevice(device)}`);
    if (this.pending) lines.push(this.describePending(this.pending));
    else lines.push('待回复：无');
    const tail = [`已转发：${this.forwarded} 条`];
    const recentError = this.lastReplyError ?? this.lastError;
    if (recentError) tail.push(`最近错误：${recentError}`);
    lines.push(tail.join('；'));
    if (this.lastReplyAt) lines.push(`最近转发：${this.lastReplyAt}`);
    if (this.lastAt) lines.push(`最近一条：${this.lastAt}`);
    lines.push(`回传：${replyKeywordSummary(cfg)}`);
    return lines.join('\n');
  }

  private describeDevice(device: DeviceInfo): string {
    const client = [device.client, device.clientVersion].filter(Boolean).join(' ');
    const token = device.tokenLabel ? `｜令牌「${device.tokenLabel}」` : '';
    if (device.online) {
      const span = Math.max(0, Date.now() - (device.connectedAt ?? device.lastSeenAt));
      const queue = this.pendingReplyCount(device.deviceId);
      return `${device.deviceName}（${client || 'dsh'}${token}）已连 ${formatDuration(span)}，`
        + `收到 ${device.received} 条，待发回传 ${queue}`;
    }
    const recent = this.formatClock(device.lastSeenAt);
    return `${device.deviceName}（离线，最近 ${recent}${device.tokenLabel ? `，令牌「${device.tokenLabel}」` : ''}）`;
  }

  private describePending(pending: PendingReply): string {
    const name = pending.deviceName || pending.deviceId;
    const title = pending.sessionTitle ? `会话「${pending.sessionTitle}」` : `会话 ${pending.sessionId}`;
    return `待回复：${name} / ${title}`;
  }

  private formatClock(ms: number): string {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: this.opts.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString().slice(11, 16);
    }
  }
}

/** 状态工具里的一行：当前回传靠哪些关键字触发，或已关闭（关键字留空）。 */
function replyKeywordSummary(cfg: NotifyReceiverConfigSection): string {
  const keywords = parseKeywords(cfg.replyKeywords);
  if (keywords.length === 0) return '关闭（未配置关键字）';
  const listed = keywords.slice(0, 5).map((keyword) => `「${keyword}」`).join('、');
  const more = keywords.length > 5 ? ' 等' : '';
  return `关键字 ${listed}${more}`;
}

