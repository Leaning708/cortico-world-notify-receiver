import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { NOTIFY_RECEIVER_DEFAULTS, type NotifyReceiverConfigSection } from './config.ts';
import { NOTIFY_RECEIVER_TOOL_DECLS, NotifyReceiverWorld } from './world.ts';

export const NOTIFY_RECEIVER: WorldDefinition<NotifyReceiverConfigSection> = {
  id: 'notify-receiver',
  label: 'Notify Receiver',
  defaults: () => ({ ...NOTIFY_RECEIVER_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.notify-receiver` 的活引用；host/port 在 start() 时读取，改完重启 World 生效。
  // 令牌表按 `ctx.dataDir` 落在 `<dataDir>/worlds/notify-receiver/tokens.json`。
  // 不声明 configOptions / ConfigGroup：面板保存走 invoke('config.save') + ctx.persist。
  create: (ctx) => new NotifyReceiverWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    persist: (patch) => ctx.persist(patch),
  }),
  // 自描述：可能出现的全部工具与会推出的全部事件，不进提示词。
  describe: {
    tools: describeTools(NOTIFY_RECEIVER_TOOL_DECLS, {
      dsh_notify_status: {
        zh: '查看 Notify Receiver 服务是否在监听、ws:// 地址、令牌与设备数量，以及待回复和失败的转回。',
        en: 'Shows whether the Notify Receiver server is listening, its ws:// URL, token and device counts, and pending or failed replies.',
      },
    }),
    events: [
      {
        type: 'dsh-notify.task',
        description: {
          zh: '收到一条 DSH 任务通知，可能是完成，也可能是失败。',
          en: 'A DSH task notification arrived; it may report completion or failure.',
        },
        trigger: 'flush',
      },
      {
        type: 'dsh-notify.connected',
        description: {
          zh: '一台 DSH 设备通过 WebSocket 连上了；默认让 Coo 说一句，关掉 announceConnections 后只记录。',
          en: 'A DSH device connected over WebSocket; announced to the bot by default, recorded only when announceConnections is off.',
        },
      },
      {
        type: 'dsh-notify.disconnected',
        description: {
          zh: '一台 DSH 设备断开了；默认让 Coo 说一句，关掉 announceConnections 后只记录。',
          en: 'A DSH device disconnected; announced to the bot by default, recorded only when announceConnections is off.',
        },
      },
      {
        type: 'dsh-notify.listening',
        description: {
          zh: 'Notify Receiver 的 WebSocket 服务开始监听；只记录，不唤醒。',
          en: 'The Notify Receiver WebSocket server started listening; recorded without waking the bot.',
        },
      },
      {
        type: 'dsh-notify.replied',
        description: {
          zh: '已把用户的关键字回复排队或发给 DSH；只记录，不唤醒。',
          en: 'A keyword reply from the user was queued for or forwarded to DSH; recorded without waking the bot.',
        },
      },
      {
        type: 'dsh-notify.reply-failed',
        description: {
          zh: '回传最终失败：设备离线超过保留时长，或 reply-result 连续失败；只记录，不唤醒。',
          en: 'A reply never reached DSH: the device stayed offline past the TTL, or reply-result kept failing; recorded without waking the bot.',
        },
      },
    ],
  },
};
