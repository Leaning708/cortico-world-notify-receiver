/** World 测试共用的假宿主:记录推送的事件与唤醒口径,其余宿主接口都是空实现。 */
import type { EventEnvelope, WorldHost, PushOptions } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  /** 事件库内容；测试可直接 push，供 onTurnEnded 读取 console.message。 */
  storeEvents: EventEnvelope[] = [];
  pushDeferred(): void {}
  store = {
    get: (cursor: number) => this.storeEvents.find((event) => event.cursor === cursor),
    latestCursor: () => (this.storeEvents.length ? this.storeEvents[this.storeEvents.length - 1]!.cursor : 0),
    range: (query: { source?: string; fromCursor?: number; toCursor?: number; toTs?: string; limit?: number }) => {
      let rows = this.storeEvents.filter((event) => {
        if (query.source !== undefined && event.source !== query.source) return false;
        if (query.fromCursor !== undefined && event.cursor < query.fromCursor) return false;
        if (query.toCursor !== undefined && event.cursor > query.toCursor) return false;
        if (query.toTs !== undefined && new Date(event.ts).getTime() > new Date(query.toTs).getTime()) return false;
        return true;
      });
      if (query.limit !== undefined && rows.length > query.limit) rows = rows.slice(-query.limit);
      return rows;
    },
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  /** 与 events 逐条对齐:唤醒/攒批的口径也要能断言 */
  pushOpts: Array<PushOptions | undefined> = [];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}
