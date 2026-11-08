/** 测试用的 Notify Receiver 世界：临时 dataDir、一个令牌、随机端口，退出时清理。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { NOTIFY_RECEIVER } from '../../src/definition.ts';
import type { NotifyReceiverConfigSection } from '../../src/config.ts';
import { NotifyReceiverWorld } from '../../src/world.ts';
import { FakeHost } from './fake-host.ts';

export interface StartedBridge {
  world: NotifyReceiverWorld;
  host: FakeHost;
  /** `ws://127.0.0.1:<port>/ws` */
  url: string;
  /** 新建的令牌明文；DSH 侧握手头填它。 */
  token: string;
  /** 令牌 id；禁用/删除/轮换测试用。 */
  tokenId: string;
  /** `config.save` 实际交给 `WorldContext.persist` 的补丁，按调用顺序。 */
  persisted: Array<Partial<NotifyReceiverConfigSection>>;
  events(): string[];
  close(): Promise<void>;
}

export interface StartOptions {
  /** 是否先建一个令牌（默认建）。 */
  token?: boolean;
  tokenLabel?: string;
}

export async function startBridge(
  overrides: Partial<NotifyReceiverConfigSection> = {},
  opts: StartOptions = {},
): Promise<StartedBridge> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'notify-receiver-'));
  const ctx = fakeWorldContext(NOTIFY_RECEIVER, { scratchDir });
  Object.assign(ctx.cfg, {
    host: '127.0.0.1',
    port: 0,
    // 回传只剩关键字匹配；具体关键字各用例按需覆盖。
    replyKeywords: '回复,转给DSH',
    replyKeywordMatch: 'prefix',
    stripKeyword: true,
    // 大多数用例不关心上下线播报，默认关掉以免事件列表被噪声打乱。
    announceConnections: false,
  }, overrides);
  // 记录面板保存写回的内容；同时保留 fakeWorldContext 原有的活对象赋值。
  const persisted: Array<Partial<NotifyReceiverConfigSection>> = [];
  const persist = ctx.persist.bind(ctx);
  ctx.persist = (patch) => {
    persisted.push(patch as Partial<NotifyReceiverConfigSection>);
    persist(patch);
  };
  const world = NOTIFY_RECEIVER.create(ctx) as NotifyReceiverWorld;
  const invoke = world.webUi().invoke!;
  let token = '';
  let tokenId = '';
  if (opts.token !== false) {
    const generated = await invoke('tokens', 'tokens.add', [{ label: opts.tokenLabel ?? '测试' }]) as {
      token: string;
      id: string;
    };
    token = generated.token;
    tokenId = generated.id;
  }
  const host = new FakeHost();
  try {
    await world.start(host);
  } catch (error) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  }
  return {
    world,
    host,
    url: world.wsUrl(),
    token,
    tokenId,
    persisted,
    events: () => host.events.map((event) => event.type),
    async close() {
      await world.stop();
      rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}

/** 在事件库里补一条控制台消息（用户对 Coo 说话）。 */
export function addConsoleMessage(
  host: FakeHost,
  cursor: number,
  body: string,
  ts = new Date().toISOString(),
): void {
  host.storeEvents.push({
    cursor,
    type: 'console.message',
    origin: 'internal',
    source: 'console',
    ts,
    senderKey: 'Console',
    text: `[time] Console: ${body}`,
    meta: { from: 'Console', body },
  } as EventEnvelope);
}

/** Coopanion 桌宠通道：用户消息是 desktop-pet.message，原文在 meta.text。 */
export function addDesktopPetMessage(
  host: FakeHost,
  cursor: number,
  body: string,
  ts = new Date().toISOString(),
): void {
  host.storeEvents.push({
    cursor,
    type: 'desktop-pet.message',
    origin: 'external',
    source: 'desktop-pet',
    ts,
    senderKey: 'desktop-pet.text',
    text: `[18:09] [typed] 爸比:${body}`,
    meta: { via: 'bubble', text: body },
  } as EventEnvelope);
}

/** pet_ask 的选项回答；和主动消息一样参与回复匹配（0.3.2 起不再特殊忽略）。 */
export function addDesktopPetAnswer(host: FakeHost, cursor: number, body: string): void {
  host.storeEvents.push({
    cursor,
    type: 'desktop-pet.message',
    origin: 'external',
    source: 'desktop-pet',
    ts: new Date().toISOString(),
    senderKey: 'desktop-pet.answer',
    text: `[answer] ${body}`,
    meta: { via: 'answer', text: body },
  } as EventEnvelope);
}

/** 等到条件成立；用于等待异步的事件投递。 */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = '条件',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待${label}超时`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

export interface PanelDevice {
  deviceId: string;
  deviceName: string;
  online: boolean;
  received: number;
  pendingReplies: number;
}

export interface PanelState {
  tokenSet: boolean;
  values: Record<string, string | number | boolean>;
  tokens: Array<{ id: string; label: string; prefix: string; enabled: boolean }>;
  devices: PanelDevice[];
  status: { listening: boolean; wsUrl: string; onlineDevices: number };
}

/** 读一次面板快照（等价于浏览器里 `ctx.invoke('state')`）。 */
export async function panelState(bridge: StartedBridge): Promise<PanelState> {
  return bridge.world.webUi().invoke!('service', 'state', []) as Promise<PanelState>;
}

/** 轮询面板快照直到 `done` 成立；返回最后一次快照。 */
export async function waitForPanel(
  bridge: StartedBridge,
  done: (state: PanelState) => boolean,
  label = '面板条件',
  timeoutMs = 3_000,
): Promise<PanelState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await panelState(bridge);
    if (done(state)) return state;
    if (Date.now() > deadline) throw new Error(`等待${label}超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
