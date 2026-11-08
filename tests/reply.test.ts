import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, ToolCallContext } from 'cortico/core/types.ts';
import { OFFLINE_REPLY_TTL_MS } from '../src/world.ts';
import {
  addConsoleMessage,
  addDesktopPetAnswer,
  addDesktopPetMessage,
  panelState,
  startBridge,
  waitForPanel,
  waitUntil,
  type StartedBridge,
} from './helpers/bridge.ts';
import { connectClient, replyResultFrame, type TestClient } from './helpers/ws-client.ts';

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

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const replies = (client: TestClient): Array<Record<string, unknown>> =>
  client.frames.filter((frame) => frame.type === 'reply');

const taskEvent = (bridge: StartedBridge): EventEnvelope =>
  bridge.host.events.find((event) => event.type === 'dsh-notify.task')!;

const statusText = async (bridge: StartedBridge): Promise<string> => {
  const tool = bridge.world.tools().find((item) => item.name === 'dsh_notify_status')!;
  const result = await tool.handler({}, {} as ToolCallContext);
  return typeof result === 'string' ? result : result.text;
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 等第 `index` 条 ack；同一连接可能已经收到过前面的 ack。 */
async function waitForAck(client: TestClient, index: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const acks = client.frames.filter((frame) => frame.type === 'ack');
    if (acks.length > index) return acks[index]!;
    if (Date.now() > deadline) throw new Error('等待 ack 超时');
    await sleep(5);
  }
}

/** 发一条通知并等它的 ack；返回通知游标。 */
async function notify(client: TestClient, overrides: Record<string, unknown> = {}): Promise<number> {
  const before = client.frames.filter((frame) => frame.type === 'ack').length;
  client.sendTask(overrides);
  const ack = await waitForAck(client, before);
  return Number(ack.cursor);
}

describe('回传：按设备路由', () => {
  it('关键字命中后只发给发通知的那台设备', async () => {
    const bridge = await start();
    const first = await connect(bridge.url, { headers: bearer(bridge.token) });
    await first.waitFor('hello-ok');
    const second = await connect(bridge.url, {
      headers: bearer(bridge.token),
      hello: { deviceId: 'dev-2', deviceName: '公司笔记本' },
    });
    await second.waitFor('hello-ok');

    const cursor = await notify(first, { msgId: 'm-route', sessionId: 'session-42', title: '修登录页' });
    addConsoleMessage(bridge.host, cursor + 1, '回复：把测试跑一下');
    bridge.world.onTurnEnded();

    const reply = await first.waitFor('reply');
    expect(reply).toMatchObject({ taskId: 'm-route', sessionId: 'session-42', text: '把测试跑一下' });
    expect(typeof reply.replyId).toBe('string');
    expect(replies(second)).toHaveLength(0);

    first.send(replyResultFrame(String(reply.replyId), true));
    await waitForPanel(bridge, (state) => (state.devices[0]?.pendingReplies ?? 0) === 0, '回传出队');
    expect(await statusText(bridge)).toContain('待发回传 0');
  });

  it('通知正文只写关键字规则，不提时间与条数', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    await notify(client, { msgId: 'm-hint', sessionId: 'session-hint' });
    const text = taskEvent(bridge).text;
    expect(text).toContain('回复规则');
    expect(text).toContain('以「回复」或「转给DSH」开头');
    expect(text).not.toMatch(/秒|最多|窗口/);
  });
});

describe('回传：失败通知一样开待回复', () => {
  it('failed 通知也开待回复，关键字回复照常转发成功', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-failed', status: 'failed', sessionId: 'session-fail' });
    expect(taskEvent(bridge).text).toContain('回复规则');

    addDesktopPetMessage(bridge.host, cursor + 1, '回复重试');
    bridge.world.onTurnEnded();
    const reply = await client.waitFor('reply');
    expect(reply).toMatchObject({ taskId: 'm-failed', sessionId: 'session-fail', text: '重试' });

    client.send(replyResultFrame(String(reply.replyId), true));
    await waitForPanel(bridge, (state) => (state.devices[0]?.pendingReplies ?? 0) === 0, '失败通知的回传出队');
  });
});

describe('回传：一轮内全部转发', () => {
  it('同一轮多条关键字消息全部按游标顺序转发，同一条不会转两次', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-multi', sessionId: 'session-multi' });

    addConsoleMessage(bridge.host, cursor + 1, '普通聊天，不该转');
    addDesktopPetMessage(bridge.host, cursor + 2, '回复第一条');
    addConsoleMessage(bridge.host, cursor + 3, '回复:第二条');
    addDesktopPetMessage(bridge.host, cursor + 4, '转给DSH 第三条');
    bridge.world.onTurnEnded();

    await waitUntil(() => replies(client).length >= 3, 3_000, '三条回传');
    expect(replies(client).map((frame) => frame.text)).toEqual(['第一条', '第二条', '第三条']);
    expect(new Set(replies(client).map((frame) => frame.replyId)).size).toBe(3);

    // 再扫一轮不会重复转发已经推进过游标的同一条。
    bridge.world.onTurnEnded();
    await sleep(80);
    expect(replies(client)).toHaveLength(3);
  });
});

describe('回传：没有过期时间', () => {
  it('消息时间推进很久仍会转发，转发完待回复也不消失', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-late', sessionId: 'session-late' });

    const farFuture = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    addConsoleMessage(bridge.host, cursor + 1, '回复：很久以后', farFuture);
    bridge.world.onTurnEnded();

    const reply = await client.waitFor('reply');
    expect(reply.text).toBe('很久以后');
    // 没有条数上限/过期：待回复仍然绑定这台设备与会话。
    expect(await statusText(bridge)).toContain('待回复：家里台式机 / 会话');
  });
});

describe('回传：下一条通知替换上一条', () => {
  it('新通知替换绑定：旧游标之前的消息不再转发，新会话的消息照常转', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const firstCursor = await notify(client, { msgId: 'm-old', sessionId: 'session-old' });

    // 旧绑定之后、替换通知之前：旧游标范围内的消息，替换后被跳过。
    addConsoleMessage(bridge.host, firstCursor + 1, '回复：替换前的消息');
    const secondCursor = await notify(client, { msgId: 'm-new', sessionId: 'session-new' });
    expect(secondCursor).toBeGreaterThan(firstCursor);

    bridge.world.onTurnEnded();
    await sleep(80);
    expect(replies(client)).toHaveLength(0);
    // 待回复绑定已换成第二条通知：游标和会话都以新通知为准。
    expect(await statusText(bridge)).not.toContain('待回复：无');

    addDesktopPetMessage(bridge.host, secondCursor + 1, '回复：新会话的消息');
    bridge.world.onTurnEnded();
    const reply = await client.waitFor('reply');
    expect(reply).toMatchObject({ taskId: 'm-new', sessionId: 'session-new', text: '新会话的消息' });
  });
});

describe('回传：设备断开后失效', () => {
  it('设备断开后待回复失效，重连也不会补发断开之后的消息', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-drop', sessionId: 'session-drop' });

    client.close();
    await client.waitClosed();
    await waitForPanel(bridge, (state) => state.devices[0]?.online === false, '设备离线');

    addConsoleMessage(bridge.host, cursor + 1, '回复：断开后说的话');
    bridge.world.onTurnEnded();
    await sleep(80);
    expect(replies(client)).toHaveLength(0);
    expect(await statusText(bridge)).toContain('待回复：无');

    const reconnected = await connect(bridge.url, { headers: bearer(bridge.token) });
    await reconnected.waitFor('hello-ok');
    bridge.world.onTurnEnded();
    await sleep(80);
    expect(replies(reconnected)).toHaveLength(0);
  });
});

describe('回传：关键字留空 = 关闭回传', () => {
  it('关键字留空时不转发，提示里也不写规则', async () => {
    const bridge = await start({ replyKeywords: '' });
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-empty', sessionId: 'session-empty' });
    expect(taskEvent(bridge).text).not.toContain('回复规则');

    addConsoleMessage(bridge.host, cursor + 1, '回复：这条不该转');
    bridge.world.onTurnEnded();
    await sleep(80);
    expect(replies(client)).toHaveLength(0);
    expect(await statusText(bridge)).toContain('回传：关闭（未配置关键字）');
  });
});

describe('回传：排队与补发', () => {
  it('还没收到 reply-result 就断线：重连后补发同一条 replyId', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-offline', sessionId: 'session-offline' });
    addConsoleMessage(bridge.host, cursor + 1, '回复：离线前说的话');
    bridge.world.onTurnEnded();
    const reply = await client.waitFor('reply');
    expect(reply).toMatchObject({ sessionId: 'session-offline', text: '离线前说的话' });

    // 不回落 reply-result 就断开：待回复失效，但已入队的回传留在世界一层。
    client.close();
    await client.waitClosed();
    await waitForPanel(bridge, (state) => state.devices[0]?.online === false, '设备离线');
    expect((await panelState(bridge)).devices.find((device) => device.deviceId === 'dev-1'))
      .toMatchObject({ online: false, pendingReplies: 1 });

    const reconnected = await connect(bridge.url, { headers: bearer(bridge.token) });
    await reconnected.waitFor('hello-ok');
    const resent = await reconnected.waitFor('reply');
    expect(resent.replyId).toBe(reply.replyId);

    reconnected.send(replyResultFrame(String(resent.replyId), true));
    await waitForPanel(bridge, (state) => (state.devices[0]?.pendingReplies ?? 1) === 0, '补发出队');
  });

  it('排队超过固定的 10 分钟 TTL 后记 reply-failed', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-ttl', sessionId: 'session-ttl' });
    addConsoleMessage(bridge.host, cursor + 1, '回复：没人收的话');
    bridge.world.onTurnEnded();
    await client.waitFor('reply');
    client.close();
    await client.waitClosed();
    await waitForPanel(bridge, (state) => state.devices[0]?.online === false, '设备离线');

    // 离线保留时长是模块常量：拨快 10 分钟，让扫描判定过期。
    expect(OFFLINE_REPLY_TTL_MS).toBe(600_000);
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + OFFLINE_REPLY_TTL_MS + 1);
    try {
      bridge.world.sweepOfflineReplies();
    } finally {
      nowSpy.mockRestore();
    }

    await waitUntil(() => bridge.events().includes('dsh-notify.reply-failed'), 3_000, '回传失败');
    const failed = bridge.host.events.find((event) => event.type === 'dsh-notify.reply-failed')!;
    expect(failed.text).toContain('设备离线超时');
    expect(failed.meta).toMatchObject({ deviceId: 'dev-1', reason: '设备离线超时' });
  });
});

describe('回传：reply-result 失败重试', () => {
  it('失败最多重发 3 次，之后记 reply-failed', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-retry', sessionId: 'session-retry' });
    addConsoleMessage(bridge.host, cursor + 1, '回复：重试三次');
    bridge.world.onTurnEnded();

    const first = await client.waitFor('reply');
    const replyId = String(first.replyId);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitUntil(() => replies(client).length >= attempt, 3_000, `第 ${attempt} 次回传`);
      expect(replies(client)[attempt - 1]!.replyId).toBe(replyId);
      client.send(replyResultFrame(replyId, false, `第 ${attempt} 次注入失败`));
      await sleep(20);
    }

    await waitUntil(() => bridge.events().includes('dsh-notify.reply-failed'), 3_000, '回传失败事件');
    const failed = bridge.host.events.find((event) => event.type === 'dsh-notify.reply-failed')!;
    expect(failed.meta).toMatchObject({ replyId, attempts: 3 });
    expect(failed.text).toContain('已尝试 3 次');
    expect(replies(client)).toHaveLength(3);
  });
});

describe('回传：pet_ask 的回答', () => {
  it('pet_ask 的回答不再被忽略：照常当用户消息参与匹配', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-answer', sessionId: 'session-answer' });

    // 对 pet_ask 选项的回答带着关键字，应当直接转给 DSH。
    addDesktopPetAnswer(bridge.host, cursor + 1, '回复这是选项回答');
    bridge.world.onTurnEnded();
    const reply = await client.waitFor('reply');
    expect(reply.text).toBe('这是选项回答');
    expect(replies(client)).toHaveLength(1);
  });
});

describe('回传：状态工具', () => {
  it('状态工具报告待回复与已转发条数', async () => {
    const bridge = await start();
    const client = await connect(bridge.url, { headers: bearer(bridge.token) });
    await client.waitFor('hello-ok');
    const cursor = await notify(client, { msgId: 'm-status-reply', sessionId: 'session-9' });

    expect(await statusText(bridge)).toContain('待回复：家里台式机');

    addConsoleMessage(bridge.host, cursor + 1, '回复：继续');
    bridge.world.onTurnEnded();
    await client.waitFor('reply');
    await sleep(50);
    const text = await statusText(bridge);
    // 待回复不会因为转发一条就消失：没有条数上限。
    expect(text).toContain('待回复：家里台式机');
    expect(text).toContain('已转发：1 条');
  });
});
