export type ReplyKeywordMatch = 'prefix' | 'contains' | 'regex';
/** 通知正文里写不写设备名：多设备才写 / 总写 / 不写。 */
export type DeviceInText = 'auto' | 'always' | 'never';

/**
 * `config.json` 的 `worlds.notify-receiver` 段；默认关闭，由部署或 bot 启用。
 *
 * 没有 `token`：令牌是多条的结构化列表，配置组装不下，改存
 * `<dataDir>/worlds/notify-receiver/tokens.json`，面板走 `invoke()` 增删。
 * 这个包不声明 ConfigGroup（不再生成「配置」页签），面板保存走
 * `invoke('config.save', [patch])`，由 `config-save.ts` 校验后持久化。
 *
 * 回传只有一种判定：关键字匹配。没有模式、窗口、条数上限或冷却；
 * 关键字留空表示不转发（等价于关闭回传）。
 */
export interface NotifyReceiverConfigSection {
  enabled: boolean;
  /** 发布地址。`127.0.0.1` 只接受本机连接；要让另一台设备连进来时填 `0.0.0.0` 或本机局域网地址。 */
  host: string;
  /** 发布端口。`0` 由系统分配（测试用）；默认 3210。 */
  port: number;
  /** 心跳间隔（秒）；两次没有 pong 就断开。 */
  heartbeatSec: number;
  /** 同时在线设备上限。 */
  maxDevices: number;
  /** 没有任何可用令牌时，是否允许本机匿名连接（调试用）。 */
  allowAnonymousLoopback: boolean;
  /** 通知正文里写不写设备名。 */
  deviceInText: DeviceInText;
  /** 设备上线/下线是否让 Coo 说一句。 */
  announceConnections: boolean;
  /** 关键字列表，逗号或换行分隔；留空表示不转发（关闭回传）。 */
  replyKeywords: string;
  /** 关键字匹配方式；匹配固定不区分大小写。 */
  replyKeywordMatch: ReplyKeywordMatch;
  /** 转发前是否把命中的关键字从正文里去掉。 */
  stripKeyword: boolean;
}

export const NOTIFY_RECEIVER_DEFAULTS: NotifyReceiverConfigSection = {
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
};
