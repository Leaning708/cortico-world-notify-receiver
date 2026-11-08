import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../src/tokens.ts';
import { CLOSE_CODES, MAX_FRAME_BYTES } from '../src/protocol.ts';
import {
  WsBridgeServer,
  type DeviceInfo,
  type WsBridgeConnection,
  type WsBridgeHooks,
  type WsBridgeServerOptions,
} from '../src/ws-server.ts';
import { connectClient, helloFrame, taskFrame, type TestClient } from './helpers/ws-client.ts';

interface Recorded {
  tasks: Array<{ deviceId: string; msgId: string; sessionId: string }>;
  connected: DeviceInfo[];
  disconnected: DeviceInfo[];
  replyResults: Array<{ deviceId: string; replyId: string; ok: boolean; error?: string }>;
  ticks: number;
}

let scratchDir = '';
let tokens: TokenStore;
let token = '';
let tokenId = '';
const servers: WsBridgeServer[] = [];
const clients: TestClient[] = [];

function recordHooks(overrides: Partial<WsBridgeHooks> = {}): { hooks: WsBridgeHooks; recorded: Recorded } {
  const recorded: Recorded = { tasks: [], connected: [], disconnected: [], replyResults: [], ticks: 0 };
  let cursor = 0;
  const hooks: WsBridgeHooks = {
    onTask: async (conn: WsBridgeConnection, note, msgId) => {
      recorded.tasks.push({ deviceId: conn.deviceId, msgId, sessionId: note.sessionId });
      cursor += 1;
      return { cursor };
    },
    onConnected: (conn) => {
      recorded.connected.push({
        deviceId: conn.deviceId,
        deviceName: conn.deviceName,
        client: conn.client,
        clientVersion: conn.clientVersion,
        tokenLabel: conn.tokenLabel,
        lastSeenAt: Date.now(),
        received: 0,
        online: true,
      });
    },
    onDisconnected: (device) => {
      recorded.disconnected.push(device);
    },
    onReplyResult: (deviceId, replyId, ok, error) => {
      recorded.replyResults.push({ deviceId, replyId, ok, error });
    },
    onTick: () => {
      recorded.ticks += 1;
    },
    ...overrides,
  };
  return { hooks, recorded };
}

async function startServer(
  overrides: Partial<WsBridgeServerOptions> = {},
  hooksOverride: Partial<WsBridgeHooks> = {},
): Promise<{ server: WsBridgeServer; recorded: Recorded }> {
  const { hooks, recorded } = recordHooks(hooksOverride);
  const server = new WsBridgeServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatSec: 30,
    maxDevices: 8,
    allowAnonymousLoopback: true,
    tokens,
    version: '0.3.0',
    hooks,
    ...overrides,
  });
  await server.start();
  servers.push(server);
  return { server, recorded };
}

function connect(url: string, opts: Parameters<typeof connectClient>[1] = {}): Promise<TestClient> {
  return connectClient(url, opts).then((client) => {
    clients.push(client);
    return client;
  });
}

const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` });

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'notify-receiver-ws-'));
  tokens = TokenStore.forDataDir(scratchDir);
  const generated = tokens.generate('测试令牌');
  token = generated.token;
  tokenId = generated.id;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('WS 服务端：握手与鉴权', () => {
  it('握手头 Bearer 令牌通过，收到 hello-ok 与心跳/上限', async () => {
    const { server, recorded } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    const ack = await client.waitFor('hello-ok');
    expect(ack).toMatchObject({
      deviceId: 'dev-1',
      serverVersion: '0.3.0',
      heartbeatSec: 30,
      limits: { maxFrameBytes: MAX_FRAME_BYTES, maxReplyChars: 8000 },
    });
    expect(recorded.connected).toHaveLength(1);
    expect(recorded.connected[0]).toMatchObject({ deviceId: 'dev-1', deviceName: '家里台式机' });
  });

  it('握手头令牌不对：回 error 帧并 close(4401)', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer('cwb_wrong'), hello: false });
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'unauthorized' });
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.unauthorized);
  });

  it('没有握手头时用 hello.token 鉴权', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { hello: { token } });
    await client.waitFor('hello-ok');
    expect(server.isOnline('dev-1')).toBe(true);
  });

  it('hello.token 不对：close(4401)', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { hello: { token: 'cwb_wrong' } });
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'unauthorized' });
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.unauthorized);
  });

  it('没有任何可用令牌时允许本机匿名连接', async () => {
    const empty = TokenStore.forDataDir(join(scratchDir, 'empty'));
    const { server } = await startServer({ tokens: empty });
    const client = await connect(server.wsUrl());
    await client.waitFor('hello-ok');
  });

  it('存在可用令牌但没带：close(4401)', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl());
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'unauthorized' });
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.unauthorized);
  });

  it('关掉 allowAnonymousLoopback 后匿名连接被拒', async () => {
    const empty = TokenStore.forDataDir(join(scratchDir, 'empty2'));
    const { server } = await startServer({ tokens: empty, allowAnonymousLoopback: false });
    const client = await connect(server.wsUrl());
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.unauthorized);
  });

  it('带 Origin 且不是本机页面：close(4403)', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), {
      headers: { ...bearer(token), origin: 'https://evil.example' },
      hello: false,
    });
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.revoked);
  });

  it('本机页面的 Origin 放行', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), {
      headers: { ...bearer(token), origin: 'http://127.0.0.1:8080' },
    });
    await client.waitFor('hello-ok');
  });

  it('5 秒内没发 hello：close(4408)', async () => {
    const { server } = await startServer({ helloTimeoutMs: 60 });
    const client = await connect(server.wsUrl(), { headers: bearer(token), hello: false });
    expect((await client.waitClosed(2_000)).code).toBe(CLOSE_CODES.helloTimeout);
  });
});

describe('WS 服务端：设备注册表', () => {
  it('同一 deviceId 的新连接顶掉旧连接（4409）', async () => {
    const { server } = await startServer();
    const first = await connect(server.wsUrl(), { headers: bearer(token) });
    await first.waitFor('hello-ok');
    const second = await connect(server.wsUrl(), { headers: bearer(token) });
    await second.waitFor('hello-ok');
    expect((await first.waitClosed()).code).toBe(CLOSE_CODES.replaced);
    expect(server.onlineCount()).toBe(1);
  });

  it('在线设备超过 maxDevices：close(4429)', async () => {
    const { server } = await startServer({ maxDevices: 1 });
    const first = await connect(server.wsUrl(), { headers: bearer(token) });
    await first.waitFor('hello-ok');
    const second = await connect(server.wsUrl(), {
      headers: bearer(token),
      hello: { deviceId: 'dev-2', deviceName: '公司笔记本' },
    });
    expect((await second.waitClosed()).code).toBe(CLOSE_CODES.tooManyDevices);
    expect(server.onlineCount()).toBe(1);
  });

  it('离线设备保留在快照里，online 变 false', async () => {
    const { server, recorded } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');
    client.close();
    await client.waitClosed();
    await new Promise((done) => setTimeout(done, 50));
    const snapshot = server.devicesSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ deviceId: 'dev-1', online: false });
    expect(recorded.disconnected).toHaveLength(1);
  });

  it('devices.kick 用 1013 断开', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');
    expect(server.kick('dev-1')).toBe(true);
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.retryLater);
    expect(server.kick('dev-1')).toBe(false);
  });
});

describe('WS 服务端：帧与投递', () => {
  it('task 落库后回 ack{cursor}；同一 msgId 只落库一次', async () => {
    const { server, recorded } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');

    const msgId = 'msg-fixed';
    client.send(taskFrame({ msgId }));
    const ack = await client.waitFor('ack');
    expect(ack).toMatchObject({ ref: msgId, cursor: 1 });
    expect(ack.duplicate).toBeUndefined();

    client.send(taskFrame({ msgId }));
    const duplicate = await client.waitFor('ack', (frame) => frame.duplicate === true);
    expect(duplicate).toMatchObject({ ref: msgId, cursor: 1, duplicate: true });
    expect(recorded.tasks).toHaveLength(1);
  });

  it('没发 hello 就发 task：回 not_ready，不落库', async () => {
    const { server, recorded } = await startServer();
    const client = await connect(server.wsUrl(), {
      headers: bearer(token),
      hello: false,
    });
    client.send(taskFrame({ msgId: 'msg-early' }));
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'not_ready', ref: 'msg-early' });
    expect(recorded.tasks).toHaveLength(0);
  });

  it('超过 64 KiB 的帧：close(4413)', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');
    client.send(taskFrame({ msgId: 'msg-big', text: 'x'.repeat(MAX_FRAME_BYTES + 1024) }));
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'payload_too_large' });
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.frameTooLarge);
  });

  it('reply-result 转发给 hooks', async () => {
    const { server, recorded } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');
    client.send({ v: 1, type: 'reply-result', id: 'f1', at: new Date().toISOString(), replyId: 'r-1', ok: false, error: '没会话' });
    await new Promise((done) => setTimeout(done, 30));
    expect(recorded.replyResults).toEqual([
      { deviceId: 'dev-1', replyId: 'r-1', ok: false, error: '没会话' },
    ]);
  });

  it('发送回传帧：在线成功、离线返回 false', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');
    expect(server.sendReply('dev-1', {
      replyId: 'r-1',
      taskId: 'msg-1',
      sessionId: 'session-1',
      text: '把测试跑一下',
      at: '2026-11-02T10:00:00.000Z',
    })).toBe(true);
    const reply = await client.waitFor('reply');
    expect(reply).toMatchObject({
      replyId: 'r-1',
      taskId: 'msg-1',
      sessionId: 'session-1',
      text: '把测试跑一下',
      at: '2026-11-02T10:00:00.000Z',
    });
    expect(server.sendReply('dev-none', {
      replyId: 'r-2',
      taskId: 'msg-2',
      sessionId: 'session-2',
      text: '离线',
      at: new Date().toISOString(),
    })).toBe(false);
  });

  it('每 10 秒超过 60 帧就限流并 close(1013)', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');
    for (let index = 0; index < 70; index += 1) client.send({ v: 1, type: 'pong', id: `p${index}`, at: new Date().toISOString() });
    const error = await client.waitFor('error', (frame) => frame.code === 'rate_limited');
    expect(error).toMatchObject({ code: 'rate_limited' });
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.retryLater);
  });
});

describe('WS 服务端：令牌吊销与心跳', () => {
  it('令牌被禁用后相关连接立刻 close(4403)', async () => {
    const { server } = await startServer();
    const client = await connect(server.wsUrl(), { headers: bearer(token) });
    await client.waitFor('hello-ok');
    tokens.setEnabled(tokenId, false);
    expect(server.closeTokenConnections(tokenId)).toBe(1);
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.revoked);
  });

  it('连续 2 次没有 pong 就断开；正常回 pong 的连接保持', async () => {
    const { server, recorded } = await startServer({ heartbeatSec: 0.05 });
    const dead = await connect(server.wsUrl(), {
      headers: { ...bearer(token), 'x-dead': '1' },
      hello: { deviceId: 'dev-dead' },
      wsOptions: { autoPong: false },
    });
    await dead.waitFor('hello-ok', undefined, 2_000);
    await dead.waitFor('ping', undefined, 2_000);
    expect((await dead.waitClosed(2_000)).code).toBe(CLOSE_CODES.retryLater);

    const alive = await connect(server.wsUrl(), { headers: bearer(token) });
    await alive.waitFor('hello-ok');
    await new Promise((done) => setTimeout(done, 250));
    expect(alive.ws.readyState).toBe(alive.ws.OPEN);
    expect(recorded.ticks).toBeGreaterThan(0);
  });

  it('非回环地址没有令牌时拒绝启动', async () => {
    const empty = TokenStore.forDataDir(join(scratchDir, 'empty3'));
    const { hooks } = recordHooks();
    const server = new WsBridgeServer({
      host: '0.0.0.0',
      port: 0,
      heartbeatSec: 30,
      maxDevices: 8,
      allowAnonymousLoopback: true,
      tokens: empty,
      version: '0.3.0',
      hooks,
    });
    await expect(server.start()).rejects.toThrow(/令牌/);
  });

  it('端口被占用时给出可读的启动错误', async () => {
    const { server: first } = await startServer();
    const { hooks } = recordHooks();
    const second = new WsBridgeServer({
      host: '127.0.0.1',
      port: first.port!,
      heartbeatSec: 30,
      maxDevices: 8,
      allowAnonymousLoopback: true,
      tokens,
      version: '0.3.0',
      hooks,
    });
    await expect(second.start()).rejects.toThrow(/已被占用/);
  });

  it('同端口保留 GET /health 与 404 / 426', async () => {
    const { server } = await startServer();
    const health = await fetch(`${server.baseUrl()}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, world: 'notify-receiver', listening: true });

    const missing = await fetch(`${server.baseUrl()}/nope`);
    expect(missing.status).toBe(404);

    const notUpgrade = await fetch(`${server.baseUrl()}/ws`);
    expect(notUpgrade.status).toBe(426);
  });
});
