/** 测试用的 WS 客户端：连上就发 hello，记录收到的每一帧，可按类型等待。 */
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

export interface ClosedInfo {
  code: number;
  reason: string;
}

export interface TestClient {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  connected: Promise<void>;
  closed: Promise<ClosedInfo>;
  hello(overrides?: Record<string, unknown>): void;
  send(frame: Record<string, unknown>): void;
  sendTask(overrides?: Record<string, unknown>): string;
  waitFor<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    predicate?: (frame: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  waitClosed(timeoutMs?: number): Promise<ClosedInfo>;
  close(): void;
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function baseFrame(type: string): Record<string, unknown> {
  return { v: 1, type, id: randomUUID(), at: new Date().toISOString() };
}

export function helloFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseFrame('hello'),
    deviceId: 'dev-1',
    deviceName: '家里台式机',
    client: 'dsh',
    clientVersion: '0.3.0',
    features: ['task.v1', 'reply.v1'],
    ...overrides,
  };
}

export function taskFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseFrame('task'),
    msgId: randomUUID(),
    status: 'completed',
    title: '修复登录页',
    text: '测试全部通过',
    sessionId: 'session-1',
    ...overrides,
  };
}

export function replyResultFrame(
  replyId: string,
  ok: boolean,
  error?: string,
): Record<string, unknown> {
  return { ...baseFrame('reply-result'), replyId, ok, ...(error === undefined ? {} : { error }) };
}

export function pongFrame(): Record<string, unknown> {
  return baseFrame('pong');
}

export interface ConnectOptions {
  headers?: Record<string, string>;
  /** 默认在 open 后立刻发一条默认 hello；`false` 表示不发。 */
  hello?: Record<string, unknown> | false;
  /** 透传给 `ws` 客户端；心跳用例用 `autoPong: false` 模拟僵死连接。 */
  wsOptions?: { autoPong?: boolean };
}

export function connectClient(url: string, opts: ConnectOptions = {}): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.wsOptions ?? {}),
    });
    const frames: Array<Record<string, unknown>> = [];
    let resolveClosed!: (info: ClosedInfo) => void;
    const closed = new Promise<ClosedInfo>((done) => {
      resolveClosed = done;
    });
    let resolveConnected!: () => void;
    const connected = new Promise<void>((done) => {
      resolveConnected = done;
    });

    const client: TestClient = {
      ws,
      frames,
      connected,
      closed,
      hello(overrides = {}) {
        this.send(helloFrame(overrides));
      },
      send(frame) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      },
      sendTask(overrides = {}) {
        const frame = taskFrame(overrides);
        this.send(frame);
        return String(frame.msgId);
      },
      async waitFor<T extends Record<string, unknown>>(
        type: string,
        predicate?: (frame: T) => boolean,
        timeoutMs = 3_000,
      ): Promise<T> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const found = frames.find((frame) => frame.type === type
            && (!predicate || predicate(frame as T)));
          if (found) return found as T;
          if (Date.now() > deadline) {
            throw new Error(
              `等待 ${type} 超时；已收到：${JSON.stringify(frames.map((frame) => frame.type))}`,
            );
          }
          await sleep(5);
        }
      },
      async waitClosed(timeoutMs = 3_000): Promise<ClosedInfo> {
        return Promise.race([
          closed,
          sleep(timeoutMs).then(() => {
            throw new Error('等待连接关闭超时');
          }),
        ]);
      },
      close() {
        ws.close();
      },
    };

    ws.on('open', () => {
      resolveConnected();
      if (opts.hello !== false) client.hello(typeof opts.hello === 'object' ? opts.hello : {});
      resolve(client);
    });
    ws.on('message', (data: Buffer) => {
      try {
        frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      } catch {
        frames.push({ type: '__unparseable__', raw: data.toString('utf8') });
      }
    });
    ws.on('close', (code: number, reason: Buffer) => {
      resolveClosed({ code, reason: reason.toString('utf8') });
    });
    ws.on('error', (error: Error) => {
      // 被别人拒绝/顶号时客户端也会报错；由 waitClosed 判定，这里不 reject。
      if (ws.readyState === WebSocket.CONNECTING) reject(error);
    });
  });
}
