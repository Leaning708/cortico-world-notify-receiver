# 架构

本文描述 0.3.0 的组件边界、连接时序、状态归属和关键设计。协议字段的精确说明见 [PROTOCOL.md](PROTOCOL.md)；0.2 的 HTTP 设计已退役。

## 1. 组件

```text
┌──────────────────── Coopanion（Coo）────────────────────┐
│ cortico-world-notify-receiver（World 扩展）                    │
│  ├─ src/world.ts        World 实现：事件投递、回复窗口      │
│  ├─ src/ws-server.ts    WebSocket 服务端：鉴权、设备表、心跳 │
│  ├─ src/tokens.ts       令牌表（tokens.json，只存哈希）      │
│  ├─ src/protocol.ts     帧类型与校验（纯函数）               │
│  ├─ src/reply-policy.ts 窗口/关键字/次数（纯函数）           │
│  ├─ src/note.ts         通知正文渲染与截断（纯函数）         │
│  ├─ src/config.ts       配置类型与默认值                      │
│  ├─ src/config-save.ts  面板保存的校验/夹取（纯函数）         │
│  ├─ src/webui/specs.ts  面板字段声明与可见性规则（纯函数）     │
│  ├─ src/webui/client.ts 服务/令牌/设备/回传规则 四个面板       │
│  └─ src/ENV_PROMPT.md   Coo 的行为提示                      │
└───────────────────────▲──────────────────────────────────┘
                        │ ws://<发布地址>:<端口>/ws（单端口双工）
        ┌───────────────┴───────────────┐
┌───────┴──────────── DSH ──────────────┴──────────────────┐
│ dsh-notify-sender（Host 插件，姐妹仓库）            │
│  ├─ index.js           插件入口：事件监听、生命周期         │
│  ├─ lib/notify.js      通知判定与 payload（纯逻辑）        │
│  ├─ lib/ws-client.js   连接状态机、队列、ack、心跳、回传处理 │
│  ├─ lib/client.js      Settings/Plugins 配置卡片            │
│  └─ locale/*.json                                          │
└────────────────────────────────────────────────────────────┘
```

两边的配置各自存放，不共享文件：

- Coopanion：`<Coopanion data>/home/companion/config.json` 的 `worlds.notify-receiver` 段；令牌另存 `<dataDir>/worlds/notify-receiver/tokens.json`。
- DSH：当前 profile 的插件行配置（`cordis.patch.yml` / 插件表单）。

**只开一个端口**：只有 Coopanion 监听；DSH 是客户端。这是相对 0.2 最大的结构变化——反向防火墙、端口冲突、“Coo 需要知道 DSH 地址”这三件事一起消失了。

## 2. World 侧

### 2.1 启动与关闭

`start(host)`：

1. 读 `host` / `port` / `token`；**监听非回环且令牌表为空 → 抛错拒绝启动**（写进 World 的 error 灯）。
2. `node:http` 起服务：`GET /health` + WebSocket 升级（`/ws`，其他路径 404）。
3. 写一条 `dsh-notify.listening` 事件（`deliver:false`），库里能查到接收端何时起来。

`stop()`：关闭所有连接（`1000`）→ 关服务 → 清空回复窗口。World 重启（面板「重启 World」）会重新绑定端口，改 `host`/`port` 必须重启 World。

### 2.2 连接与设备表

每条连接握手后先过鉴权，再进入 `hello`：

| 阶段 | 行为 |
|---|---|
| 升级 | 带 `Origin` 且不是本机页面 → `4403`；头里有令牌就先校验 |
| 5 秒内无 `hello` | `4408` |
| `hello` | 校验 `deviceId`、令牌（没在头里时用 `hello.token`）；同 `deviceId` 旧连接 `4409`；超 `maxDevices` → `4429`；成功回 `hello-ok` |
| ready | 心跳 `ping`/`pong`；收 `task` / `reply-result` / `pong` / `bye` |

设备表（内存 `Map<deviceId, Connection>`）保存：名称、令牌 id/label、客户端版本、连接时刻、最近活动、收到条数、待发回传队列。世界重启或进程重启后设备表清空，客户端会自动重连。

### 2.3 事件投递

`task` 帧 → 形状校验（`protocol.ts`）→ `msgId` 去重 → `host.pushEvent('dsh-notify.task', { trigger:'flush' })` → 回 `ack{cursor}`。

- 正文由 `note.ts` 渲染，只陈述事实（完成/失败、设备、会话、用时、摘要），**不写行为指令**；`ENV_PROMPT.md` 决定 Coo 怎么反应。
- `deviceInText`：`auto`（多设备在线才写设备名）/`always`/`never`。
- `announceConnections` 打开时（默认）设备上下线也投事件并唤醒 Coo，正文说明是哪台设备、用什么令牌连上的。

### 2.4 待回复绑定（0.3.3 起简化为纯关键字）

一条通知最多对应一个「待回复」绑定：

```text
收到 task（completed 与 failed 一样处理）
  ├─ 无 sessionId / 设备不在线 / 关键字为空 → 不建绑定（关键字留空 = 关闭回传）
  └─ 建绑定（deviceId + sessionId + cursor）
       ├─ 不设过期时间、不设条数上限、没有冷却
       └─ 失效只有三条：下一条通知替换 / 设备断开 / World 停止
```

`onTurnEnded`：

1. `forwarding` 时直接返回（防重入）。
2. 从 `cursor` 之后取事件，按游标升序：
   - `console.message`（正文在 `meta.body`）/ `desktop-pet.message`（正文在 `meta.text`）；
   - `pet_ask` 的 `[answer]` / `meta.via === 'answer'` 回答**不再忽略**（0.3.2 起固定参与匹配，没有开关）；
   - 用 `matchReplyText` 做关键字匹配（恒大小写不敏感，`prefix`/`contains`/`regex` 可选）。
3. 命中的消息**全部**逐条转发到绑定设备的连接；每成功一条推进 `cursor`（同一条不会转两次）。
4. 收到 `reply-result{ok:true}` 写 `dsh-notify.replied`；`ok:false` 重试最多 3 次后写 `dsh-notify.reply-failed`。
5. 转发完绑定**不会**消失——它一直有效，直到上面三条失效路径。

匹配用**消息时间戳**而不是扫描时刻，所以 Coo 一轮结束得晚也不会漏消息；因为已经没有窗口上限，晚多久都能转。

### 2.5 面板与配置

0.3.1 起**不再声明 ConfigGroup**，因此框架不会生成「配置」页签；World 页只有我们自己声明的面板：

- 页签来自 `webUi().panels`：**服务 / 令牌 / 设备 / 回传规则**（加框架的「环境提示词」页签）。
- 面板读数据用 `ctx.invoke(method, args)`；写配置用 `ctx.invoke('config.save', [patch])` → World 侧 `config-save.ts` 做白名单/枚举/夹取 → `WorldContext.persist(patch)`（深合并进 `worlds.notify-receiver` 并同步 `config.json`）。
- 为什么不用 `ctx.setConfig`：那条路要求配置组已声明，而声明了配置组就必然出现「配置」页签。放弃原始表单后，用 `persist` 自己校验写入，行为等价且更可控。
- `host`/`port` 改动后 World 实例仍绑在旧端口上：`config.save` 返回 `restartRequired`，面板提示重启 World。
- **回传规则面板只剩 3 个字段**（0.3.3 起）：回复前缀、匹配方式、是否去掉关键字再转发。没有模式/窗口/条数/冷却/失败开关——行为固定为纯关键字，关键字留空等于关闭回传。条件显示机制（`webui/specs.ts` 的 `when`）保留备用，但当前没有字段使用它。
- **令牌与设备不进配置**：令牌在 `<dataDir>/worlds/notify-receiver/tokens.json`，由 `tokens.*` 方法读写；面板不返回令牌明文，只返回 `prefix` 与是否可用。

## 3. DSH 侧

### 3.1 通知事件（与 0.2 相同）

| 事件 | 作用域 | 用途 |
|---|---|---|
| `session/event`（`global: true`） | 所有会话 | `turn/end` 时按 `notifyMode` 发通知 |
| `goal/changed`（`global: true`） | 所有会话 | 更新 goal 状态；complete/block 时发目标通知 |
| `goal/activation-changed` | 进程级 | 只更新 armed/disarmed |
| `agent/created`（`global: true`） | 所有会话 | 插件重载后从 goal 服务重新播种 |

`notifyMode`：`turn`（每轮）、`goal`（只在目标结束）、`auto`（默认：有活跃 goal 时静默，否则每轮）。活跃 goal = `phase === 'active' && activation === 'armed'`。

判定与去重逻辑（`lib/notify.js`）完全保留：`shouldNotify` 只认 `completed`/`error`；`seen` 用 `sessionId:turn`；`minTurnMs` 只作用于每轮通知；`auto` 在发 goal 通知**之前**先记 `recentClose`（10 秒），避免最终 `turn/end` 补发。

差别只有一个：命中后不 `POST`，而是 `client.sendTask(payload)` 进队列。

### 3.2 连接管理

`lib/ws-client.js` 是独立状态机，不依赖 DSH 内部 API：

```text
idle ──start()──► connecting ──open──► hello ──hello-ok──► ready
                     ▲                                        │
                     └──────── backoff ◄── close/error ◄──────┘
```

- 握手：`Authorization: Bearer` 头 + `hello`（`deviceId`/`deviceName`/`client`/`clientVersion`/`features`）。
- 退避：1s×2ⁿ 封顶 `reconnectMaxMs`，±20% 抖动；`hello-ok` 后归零。
- 心跳：回 `pong`；两个周期收不到 `ping` → 判定僵死并重连；另开 `ws.ping()` 探测。
- `enabled` 关掉、插件卸载、profile 退出：发 `bye` → `close(1000)` → 清定时器（走 `ctx.effect`）。

### 3.3 发送队列与确认

- 上限 50 条 / TTL 10 分钟，进程内存；**未连接时也入队**（0.2 是直接丢弃）。
- 发送 → 等 `ack{ref}` → 出队；重连后按序重发未 ack 的帧（同一 `msgId`，服务端去重）。
- 队列满或超时：记一条 warn（保持“不影响 DSH 本身”的原则）。

### 3.4 回传注入

收 `reply` → `ctx.sessionController.prompt({ sessionId, mode:'queue', content:[{type:'text',text}] })` → 回 `reply-result`。

- `replyId` 做去重（内存最多 1000 个键）；注入失败**不**缓存键，允许服务端重发。
- `acceptReplies: false` → 直接回 `reply-result{ok:false}`，Coo 侧按策略记 `reply-failed`。
- 不再有入站 HTTP 服务：`replyHost`/`replyPort`/`replyEnabled` 三个配置项删除。

### 3.5 配置卡片

`lib/client.js` 注册三类入口（`settings.section`、`plugins.bundle.config`、`plugins.row.config`），三者渲染同一个 React 卡片；0.3.3 删掉了 `settings.plugins.tab`，所以 Settings 里只在左栏出现一次「Coopanion Bridge」，不再同时出现在「内置插件」页签。Client 半只在 Host 启动时扫描，所以**首次安装或新增 Client 半后必须完全退出 DSH 再打开**。

0.3.1 起卡片内分三个页签（纯本地 state，不影响保存）；全局 `enabled` 总开关放在页签条上方常驻：

| 页签 | 内容 |
|---|---|
| 连接 | **本机**（设备名、设备 ID）→ 接受回传开关 → **服务列表**（表头 `启用/名称/WebSocket 地址/令牌/操作`，每条服务一行，单选启用、增删、从旧配置导入） |
| 通知 | `notifyMode`、完成/失败开关、最短耗时（`goal` 模式下隐藏）、摘要上限 |
| 高级 | 握手超时、最短/最长重连间隔 |

> 0.3.2 起子代理会话**固定不通知**（没有开关，`isSubagentSession()` 同时作用于 turn 与 goal 两条路径）。页签按钮的选中态是底部主色条 + 加粗，非选中页签没有边框；鼠标点击不出现焦点框，只有键盘聚焦（`:focus-visible`）才显示焦点环。
>
> 0.3.3 起卡片顶部只留一两句简介，**字段解释改由标题旁的小图标承载**（`InfoDot`：15px 圆形「!」，悬停或键盘聚焦时在附近弹出 tooltip，靠近视口右侧时自动右对齐）；表单因此恢复紧凑。日志/排查相关的说明并进了 `enabled` 的 tooltip。

**多服务只启用一个**：`servers` 是 `Schema.array(Schema.object({ id, label, wsUrl, token, enabled }))`；Host 侧 `normalizeServers` 规范化（丢畸形、补 id/label、标出不可用地址），活动服务 = 第一条 `enabled && usable`；多条 enabled 取第一条并告警；一条都没有就不连接。切换启用项会改变 `wsUrl`/`token` 的签名，`ws-client` 的 reconcile 据此静默重连，不做请求风暴。旧配置 `wsUrl`/`token` 在 `servers` 为空时作为一条 `legacy` 服务参与迁移，之后不再参与。

令牌在数组里是普通字符串（不是 `role('secret')`，数组元素不支持该角色），所以卡片用密码框渲染、不回显已保存值；配置文件里仍是明文，和 0.3.0 的口径一致。

## 4. 状态与并发

| 状态 | 位置 | 生命周期 |
|---|---|---|
| 设备表 / 连接 | World 进程内存 | 连接建立/断开；进程重启清空（客户端自动重连） |
| `pending` 待回复绑定 | World 进程内存 | 新通知替换；设备断开/World 停止清空（0.3.3 起无过期、无条数上限） |
| 待发回传队列 | World 进程内存（每设备） | 重连补发；10 分钟（代码常量）到期丢弃 |
| 令牌表 | `<dataDir>/worlds/notify-receiver/tokens.json` | 持久；面板增删改即时生效 |
| `seen` 通知去重 | DSH 插件内存 | 最多 1000 条，重启清空 |
| 发送队列 | DSH 插件内存 | 最多 50 条 / 10 分钟 |
| 已注入去重 | DSH 插件内存 | 最多 1000 个键 |

没有持久化队列和离线消息库：World 停机期间 DSH 队列会积压到上限，超出即丢弃并记 warn。这是有意的简单性取舍（ROADMAP 里列为后续可选）。

## 5. 安全边界

- 入口只做搬运，不执行任意命令；回传最终只是一条用户消息。
- 令牌：`tokens.json` 只存 sha256 哈希；明文 `cwb_…` 只在生成时显示一次；比较用恒定时间算法；日志只打前缀。
- 非回环监听必须至少有一个可用令牌，否则拒绝启动；匿名只在本机 + 无令牌 + 显式允许时可用。
- 带不受信 `Origin` 的升级请求一律拒绝（防浏览器页面借道本机服务）。
- 帧 64 KiB、回传文本 8000 字符、任务摘要 4000 字符；事件正文截断。
- 不内置 TLS/中继：跨公网自行加 `wss://` 隧道或反向代理。
