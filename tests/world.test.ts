import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { CLOSE_CODES } from '../src/protocol.ts';
import { NOTIFY_RECEIVER_DEFAULTS } from '../src/config.ts';
import { NOTIFY_RECEIVER_CONFIG_KEYS } from '../src/config-save.ts';
import { NOTIFY_RECEIVER } from '../src/definition.ts';
import { startBridge, waitUntil, type StartedBridge } from './helpers/bridge.ts';
import { connectClient, type TestClient } from './helpers/ws-client.ts';

const bridges: StartedBridge[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const bridge of bridges.splice(0)) await bridge.close();
});

async function start(
  overrides: Parameters<typeof startBridge>[0] = {},
  opts: Parameters<typeof startBridge>[1] = {},
): Promise<StartedBridge> {
  const bridge = await startBridge(overrides, opts);
  bridges.push(bridge);
  return bridge;
}

async function connect(
  url: string,
  opts: Parameters<typeof connectClient>[1] = {},
): Promise<TestClient> {
  const client = await connectClient(url, opts);
  clients.push(client);
  return client;
}

const bearer = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

describe('Notify Receiver World', () => {
  it('干装载不报失败：装载器会接受它', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'notify-receiver-dry-'));
    try {
      const report = await dryMountWorld(NOTIFY_RECEIVER, { scratchDir });
      expect(report.failures).toEqual([]);
      // 干装载只拿到定义、拿不到 package.json；真实包在 cortico.webUiClient 声明了面板 bundle。
      expect(report.warnings.filter((warning) => !warning.includes('cortico.webUiClient'))).toEqual([]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('默认配置：默认关闭、只监听本机、默认端口 3210、回传默认关键字', () => {
    expect(NOTIFY_RECEIVER_DEFAULTS).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 3210,
      heartbeatSec: 30,
      maxDevices: 8,
      allowAnonymousLoopback: true,
      deviceInText: 'auto',
      announceConnections: true,
      replyKeywords: '回复,转给DSH',
      replyKeywordMatch: 'prefix',
      stripKeyword: true,
    });
  });

  it('面板 state 返回配置与令牌前缀，但绝不回传明文或哈希', async () => {
    const bridge = await start();
    const state = await bridge.world.webUi().invoke!('service', 'state', []) as {
      tokenSet: boolean;
      values: Record<string, unknown>;
      tokens: Array<Record<string, unknown>>;
      devices: Array<Record<string, unknown>>;
      status: Record<string, unknown>;
    };
    expect(state.tokenSet).toBe(true);
    expect(state.values.host).toBe('127.0.0.1');
    expect(state.values.deviceInText).toBe('auto');
    expect(state.tokens).toHaveLength(1);
    expect(state.tokens[0]).toMatchObject({ label: '测试', enabled: true });
    expect(state.tokens[0]).not.toHaveProperty('hash');
    expect(state.devices).toEqual([]);
    expect(state.status.listening).toBe(true);
    const json = JSON.stringify(state);
    expect(json).not.toContain(bridge.token);
    expect(json).not.toContain('hash');
    expect(json).toContain(bridge.token.slice(0, 8));
  });

  it('面板只有 服务/令牌/设备/回传规则，且不再声明「配置」页签', async () => {
    const bridge = await start();
    const decl = bridge.world.webUi();
    // 没有 ConfigGroup：框架的 tabsOf() 不再生成「配置」页签。
    expect('config' in decl).toBe(false);
    expect(decl.config).toBeUndefined();
    expect(decl.panels?.map((panel) => panel.id)).toEqual(['service', 'tokens', 'devices', 'reply']);
    expect(decl.panels?.map((panel) => panel.title)).toEqual(['服务', '令牌', '设备', '回传规则']);
  });

  it('没有 ConfigGroup 时，面板 state 仍返回全部字段并补默认值', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'notify-receiver-defaults-'));
    try {
      const ctx = fakeWorldContext(NOTIFY_RECEIVER, { scratchDir });
      const cfg = ctx.cfg as unknown as Record<string, unknown>;
      delete cfg.heartbeatSec;
      delete cfg.replyKeywords;
      const world = NOTIFY_RECEIVER.create(ctx);
      const state = await world.webUi?.().invoke!('service', 'state', []) as {
        values: Record<string, unknown>;
      };
      expect(Object.keys(state.values).sort()).toEqual([...NOTIFY_RECEIVER_CONFIG_KEYS].sort());
      expect(state.values.heartbeatSec).toBe(NOTIFY_RECEIVER_DEFAULTS.heartbeatSec);
      expect(state.values.replyKeywords).toBe(NOTIFY_RECEIVER_DEFAULTS.replyKeywords);
      // 0.3.2 / 0.3.3 删掉的键不再出现在面板 state 里。
      for (const removed of [
        'ignorePetAnswers',
        'offlineReplyTtlMs',
        'showReplyHint',
        'replyKeywordCaseSensitive',
        'replyMode',
        'replyWindowMs',
        'replyWindowStart',
        'maxRepliesPerNotification',
        'replyOnFailed',
        'replyCooldownMs',
      ]) {
        expect(state.values).not.toHaveProperty(removed);
      }
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('收到合法通知：投一条 external 的 task 事件，按 flush 立即投递，并回 ack', async () => {
    const bridge = await start({ deviceInText: 'always' });
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');

    client.send({
      v: 1,
      type: 'task',
      id: 'f1',
      at: new Date().toISOString(),
      msgId: 'msg-1',
      status: 'completed',
      title: '修复登录页',
      text: '测试全部通过',
      sessionId: 'session-1',
      turn: 3,
      durationMs: 65_000,
    });
    const ack = await client.waitFor('ack');
    expect(ack).toMatchObject({ ref: 'msg-1', cursor: 3 });

    const events = bridge.host.events;
    expect(events.map((event) => event.type)).toEqual([
      'dsh-notify.listening',
      'dsh-notify.connected',
      'dsh-notify.task',
    ]);
    // 启动事件只落库，不唤醒 Coo；任务通知立即投递。
    expect(bridge.host.pushOpts[0]).toEqual({ deliver: false });
    expect(bridge.host.pushOpts[1]).toEqual({ deliver: false });
    expect(bridge.host.pushOpts[2]).toEqual({ trigger: 'flush' });

    const task = events[2]!;
    expect(task.origin).toBe('external');
    expect(task.source).toBe('notify-receiver');
    expect(task.senderKey).toBe('dsh:dev-1');
    expect(task.text).toContain('[DSH 任务完成]');
    expect(task.text).toContain('设备：家里台式机');
    expect(task.text).toContain('会话：修复登录页');
    expect(task.text).toContain('用时：1 分 5 秒');
    expect(task.text).toContain('最后回复：测试全部通过');
    expect(task.meta).toMatchObject({
      status: 'completed',
      deviceId: 'dev-1',
      device: '家里台式机',
      sessionId: 'session-1',
      turn: 3,
    });
  });

  it('失败通知写明错误，并且不带「最后回复」', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    client.sendTask({ status: 'failed', text: 'tsc 报错', sessionId: '' });
    await client.waitFor('ack');
    const task = bridge.host.events.find((event) => event.type === 'dsh-notify.task')!;
    expect(task.text).toContain('[DSH 任务失败]');
    expect(task.text).toContain('错误：tsc 报错');
    expect(task.text).not.toContain('最后回复');
  });

  it('deviceInText：auto 单设备不写、always 总写、never 不写；多设备时 auto 也写', async () => {
    const single = await start({ deviceInText: 'auto' });
    const one = await connect(single.url, { headers: bearer(single.token) });
    await one.waitFor('hello-ok');
    one.sendTask({ msgId: 'm-auto' });
    await one.waitFor('ack');
    const autoTask = single.host.events.find((event) => event.type === 'dsh-notify.task')!;
    expect(autoTask.text).not.toContain('设备：');

    const always = await start({ deviceInText: 'always' });
    const alwaysClient = await connect(always.url, { headers: bearer(always.token) });
    await alwaysClient.waitFor('hello-ok');
    alwaysClient.sendTask({ msgId: 'm-always' });
    await alwaysClient.waitFor('ack');
    expect(always.host.events.find((event) => event.type === 'dsh-notify.task')!.text)
      .toContain('设备：家里台式机');

    const never = await start({ deviceInText: 'never' });
    const neverClient = await connect(never.url, { headers: bearer(never.token) });
    await neverClient.waitFor('hello-ok');
    neverClient.sendTask({ msgId: 'm-never' });
    await neverClient.waitFor('ack');
    expect(never.host.events.find((event) => event.type === 'dsh-notify.task')!.text)
      .not.toContain('设备：');

    // 两台设备同时在线的 auto：正文写设备名，方便区分。
    const multi = await start({ deviceInText: 'auto' });
    const first = await connect(multi.url, { headers: bearer(multi.token) });
    await first.waitFor('hello-ok');
    const second = await connect(multi.url, {
      headers: bearer(multi.token),
      hello: { deviceId: 'dev-2', deviceName: '公司笔记本' },
    });
    await second.waitFor('hello-ok');
    first.sendTask({ msgId: 'm-multi' });
    await first.waitFor('ack');
    expect(multi.host.events.find((event) => event.type === 'dsh-notify.task')!.text)
      .toContain('设备：家里台式机');
  });

  it('announceConnections 控制上下线事件是否唤醒 Coo', async () => {
    const quiet = await start({ announceConnections: false });
    const quietClient = await connect(quiet.url, { headers: bearer(quiet.token) });
    await quietClient.waitFor('hello-ok');
    await waitUntil(() => quiet.events().includes('dsh-notify.connected'));
    const quietIndex = quiet.host.events.findIndex((event) => event.type === 'dsh-notify.connected');
    expect(quiet.host.pushOpts[quietIndex]).toEqual({ deliver: false });
    quietClient.close();
    await quietClient.waitClosed();
    await waitUntil(() => quiet.events().includes('dsh-notify.disconnected'));
    const quietBye = quiet.host.events.find((event) => event.type === 'dsh-notify.disconnected')!;
    expect(quietBye.text).toContain('已断开');
    expect(quietBye.meta).toMatchObject({ deviceId: 'dev-1' });

    const loud = await start({ announceConnections: true });
    const loudClient = await connect(loud.url, { headers: bearer(loud.token) });
    await loudClient.waitFor('hello-ok');
    await waitUntil(() => loud.events().includes('dsh-notify.connected'));
    const loudIndex = loud.host.events.findIndex((event) => event.type === 'dsh-notify.connected');
    expect(loud.host.pushOpts[loudIndex]).toEqual({ deliver: true });
    const connected = loud.host.events[loudIndex]!;
    expect(connected.text).toContain('已连上');
    expect(connected.meta).toMatchObject({ deviceId: 'dev-1', deviceName: '家里台式机', tokenLabel: '测试' });
  });

  it('握手头令牌不对：close(4401)，不投任何事件', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer('cwb_wrong') });
    const error = await client.waitFor('error');
    expect(error).toMatchObject({ code: 'unauthorized' });
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.unauthorized);
    expect(bridge.events()).toEqual(['dsh-notify.listening']);
  });

  it('同一 msgId 重发只落库一次，第二次 ack 带 duplicate', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    client.sendTask({ msgId: 'msg-dup' });
    const first = await client.waitFor('ack');
    client.sendTask({ msgId: 'msg-dup' });
    const second = await client.waitFor('ack', (frame) => frame.duplicate === true);
    expect(second.cursor).toBe(first.cursor);
    expect(bridge.events().filter((type) => type === 'dsh-notify.task')).toHaveLength(1);
  });

  it('面板令牌动作：新建给明文一次、禁用断连、轮换断旧连、删除后列表变短', async () => {
    const bridge = await start();
    const invoke = bridge.world.webUi().invoke!;
    const added = await invoke('tokens', 'tokens.add', [{ label: '公司笔记本' }]) as {
      token: string;
      id: string;
      prefix: string;
      tokens: Array<{ id: string; label: string }>;
    };
    expect(added.token.startsWith('cwb_')).toBe(true);
    expect(added.tokens).toHaveLength(2);
    expect(JSON.stringify(added.tokens)).not.toContain(added.token);

    const client = await connect(bridge.url, { headers: bearer(added.token) });
    await client.waitFor('hello-ok');
    await invoke('tokens', 'tokens.setEnabled', [{ id: added.id, enabled: false }]);
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.revoked);
    // 重新启用后旧明文仍可用。
    await invoke('tokens', 'tokens.setEnabled', [{ id: added.id, enabled: true }]);
    const reEnabled = await connect(bridge.url, { headers: bearer(added.token) });
    await reEnabled.waitFor('hello-ok');

    const rotated = await invoke('tokens', 'tokens.rotate', [{ id: added.id }]) as { token: string; id: string };
    expect(rotated.id).not.toBe(added.id);
    expect((await reEnabled.waitClosed()).code).toBe(CLOSE_CODES.revoked);
    const stale = await connect(bridge.url, { headers: bearer(added.token) });
    expect((await stale.waitClosed()).code).toBe(CLOSE_CODES.unauthorized);
    const withNew = await connect(bridge.url, { headers: bearer(rotated.token) });
    await withNew.waitFor('hello-ok');

    await invoke('tokens', 'tokens.remove', [{ id: rotated.id }]);
    expect((await withNew.waitClosed()).code).toBe(CLOSE_CODES.revoked);
    const listed = await invoke('tokens', 'state', []) as { tokens: Array<{ id: string; label: string }> };
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]!.label).toBe('测试');

    await expect(invoke('tokens', 'tokens.nope', [])).rejects.toThrow(/未知/);
  });

  it('面板 devices.kick 断开指定设备', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const result = await bridge.world.webUi().invoke!('devices', 'devices.kick', [{ deviceId: 'dev-1' }]) as {
      kicked: boolean;
    };
    expect(result.kicked).toBe(true);
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.retryLater);
  });

  it('状态工具按设计稿输出接收端、令牌、设备、待回复与已转发', async () => {
    const bridge = await start({ announceConnections: false });
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    client.sendTask({ msgId: 'm-status', sessionId: 'session-9', title: '修登录页' });
    await client.waitFor('ack');

    const tool = bridge.world.tools().find((item) => item.name === 'dsh_notify_status')!;
    const text = await tool.handler({}, {} as ToolCallContext);
    expect(text).toContain(`接收端：${bridge.url}（监听中）`);
    expect(text).toContain('令牌：1 个（1 个启用）');
    expect(text).toContain('设备：1 在线');
    expect(text).toContain('家里台式机（dsh 0.3.0｜令牌「测试」）已连');
    expect(text).toContain('收到 1 条，待发回传 0');
    expect(text).toContain('待回复：家里台式机 / 会话「修登录页」');
    expect(text).toContain('回传：关键字 「回复」、「转给DSH」');
    expect(text).toContain('已转发：0 条');
  });

  it('同端口保留 GET /health', async () => {
    const bridge = await start();
    const health = await fetch(`${bridge.world.baseUrl()}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, world: 'notify-receiver' });
  });

  it('监听非回环地址却没有任何令牌时拒绝启动', async () => {
    await expect(startBridge({ host: '0.0.0.0', port: 0 }, { token: false }))
      .rejects.toThrow(/令牌/);
  });

  it('停止后连接被关闭', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    await bridge.world.stop();
    expect((await client.waitClosed()).code).toBe(CLOSE_CODES.normal);
    expect(bridge.world.port).toBeUndefined();
  });
});
