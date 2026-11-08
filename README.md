# cortico-world-notify-receiver

Coopanion（Cortico）的 World 扩展：DSH 与 Coopanion 之间的桥的**接收端**。它在本机（或局域网）起一个 **WebSocket 服务端**，DeepSeek Harness（DSH）插件主动连过来报告任务；Coo 用桌宠的方式告诉用户，再按关键字匹配把用户回复送回 DSH 原来的会话。

DSH 侧配套插件是 `dsh-notify-sender`（**姐妹仓库**，原与本扩展同属 `coopanion-bridge` monorepo，现已分家），它作为 WebSocket 客户端连 `ws://<本机>:3210/ws`。**只有 Coopanion 这一侧需要开端口**，DSH 不再监听入站端口，也不需要在 Coo 侧配置回传地址。

数据流：

```text
DSH 侧（dsh-notify-sender）                   Coopanion 侧（本扩展）
turn/end 或 goal complete/block
  └─ ws 客户端
       ├─ hello（deviceId/deviceName/client=dsh）
       ├─ task{msgId,status,title,text,…}  ──►  /ws 服务端
       │                                        ├─ 落库 dsh-notify.task 事件
       │◄──────────────── ack{cursor} ──────────┤
       │                                        └─ Coo 说：完成/失败 + 摘要 + 回复规则
       │
用户回复（命中关键字，Coo 说完起一直有效）
       │◄──────────────── reply{replyId,sessionId,text} ──┤
       └─ prompt({sessionId, mode:'queue'}) ─► DSH 新回合
          reply-result{replyId, ok} ─────────►
```

协议、帧形状与关闭码见 [docs/WS-DESIGN.md](docs/WS-DESIGN.md) 第 3 节与 [docs/PROTOCOL.md](docs/PROTOCOL.md)（`dsh-notify.ws.v1`；本仓库是协议权威，改动需与姐妹仓库同步）。

包结构与测试起手自 Cortico 的 [`templates/extension/world`](https://github.com/Pal-AI-Lab/Cortico/tree/main/templates/extension/world)（MIT）；图标为本项目原创。

## 怎么工作

- 启动后在 `worlds.notify-receiver.host:port` 上监听：`ws://<host>:<port>/ws` 走 WebSocket，同端口的 `GET /health` 是纯 HTTP 健康检查。
- 每台 DSH 用**令牌**握手：`Authorization: Bearer <令牌>` 请求头，或首帧 `hello.token`。令牌在「令牌」面板里新建，明文只显示一次，磁盘上只存 sha256 哈希。
- 握手 5 秒内必须发 `hello`，否则服务端以 `4408` 关闭；令牌不对 `4401`，令牌被吊销或 Origin 不受信 `4403`。
- 设备注册表按 `hello.deviceId` 认机器：同 `deviceId` 的新连接顶掉旧连接（`4409`），在线设备超过 `maxDevices` 时新连接 `4429`。
- 收到 `task` 通知后投一条 `origin: external`、`trigger: flush` 的 `dsh-notify.task` 事件，并回 `ack{cursor}`；重连重发同一 `msgId` 时按 `msgId` 去重、回 `ack{duplicate: true}`。
- 每条通知（完成或失败都一样）在设备在线、有会话 id、关键字非空时建立一个**待回复绑定**，绑定设备 + 会话 + 消息游标；它不设过期时间、不设转发条数上限、没有冷却，一直有效到被下一条通知替换、设备断开或 World 停止。关键字命中后走该设备的连接发 `reply`，DSH 注入一条用户消息并回 `reply-result`。
- 每轮结束时从游标之后按顺序扫描用户消息，命中的**全部**转发；每成功一条推进游标，同一条不会转两次。关键字留空表示不转发（等于关闭回传）。
- 已排队的回传在设备重连后补发；`reply-result` 失败最多重发 3 次，离线超过 10 分钟或重试用尽时记一条 `dsh-notify.reply-failed`（只落库、不唤醒）。
- 设备上/下线默认让 Coo 说一句（`announceConnections`）；关掉后只记录事件。
- 服务端每 `heartbeatSec` 发一次 `ping`（同时打 `ws` 原生 ping），连续 2 次没有回应就断开该设备。
- 帧上限 64 KiB，单连接有背压保护与按设备限流（每 10 秒 60 帧）。
- 监听非回环地址（例如 `0.0.0.0`）时，**至少要有 1 个启用中的令牌**，否则拒绝启动；一个令牌都没有时可以用 `allowAnonymousLoopback` 放行本机匿名连接做调试。
- 跨站防护：握手带 `Origin` 且不是本机页面的一律以 `4403` 拒绝。

## 配置

在 Coopanion 高级模式的「World 总览」里启用本 World，再到它的页面配置。World 页现在有四个自定义面板，外加框架的「环境提示词」与「数据」页签：

- **服务**、**令牌**、**设备**、**回传规则**：四个自定义面板，日常用这几个。
- **环境提示词**：收到通知后怎么反应。
- **数据**：一键清除令牌表（等于吊销全部令牌）。

本扩展不声明 ConfigGroup，所以没有框架生成的「配置」页签；面板保存走 World 自己的 `invoke('config.save', [patch])`，校验、夹取后写回 `worlds.notify-receiver`，和配置文件是同一份数据。

**服务**

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `worlds.notify-receiver.host` | `127.0.0.1` | 发布地址；只接受本机连接。跨设备填 `0.0.0.0` 或本机局域网地址 |
| `worlds.notify-receiver.port` | `3210` | 发布端口；被占用时换一个 |
| `worlds.notify-receiver.heartbeatSec` | `30` | 心跳间隔（10–300 秒）；连续 2 次无回应断开 |
| `worlds.notify-receiver.maxDevices` | `8` | 同时在线设备上限（1–64） |
| `worlds.notify-receiver.allowAnonymousLoopback` | `true` | 一个可用令牌都没有时，是否放行本机匿名连接（仅调试） |
| `worlds.notify-receiver.deviceInText` | `auto` | 正文里写不写设备名：`auto` 多设备才写 / `always` / `never` |
| `worlds.notify-receiver.announceConnections` | `true` | 设备上线/下线是否让 Coo 说一句 |

**回传规则**

回传只有一种判定方式：**关键字匹配**。通知（完成与失败一样）到达时，如果设备在线、有会话 id 且关键字非空，就建立一个待回复绑定；之后每条命中关键字的用户消息都会转给 DSH。

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `worlds.notify-receiver.replyKeywords` | `回复,转给DSH` | 命中才转发；逗号/换行分隔。**留空表示不转发（等于关闭回传）** |
| `worlds.notify-receiver.replyKeywordMatch` | `prefix` | `prefix` 开头 / `contains` 包含 / `regex` 正则；固定不区分大小写 |
| `worlds.notify-receiver.stripKeyword` | `true` | 转发前去掉命中的关键字和紧跟的冒号/逗号 |

0.3.2 起以下四项**已删除、行为固定**（不再可配）：

- `ignorePetAnswers`：**不忽略** pet_ask 的 `[answer]` 回答，它和主动消息一样参与回复匹配。
- `offlineReplyTtlMs`：离线回传固定保留 10 分钟（`OFFLINE_REPLY_TTL_MS`）；面板不再显示。
- `showReplyHint`：通知正文末尾**总是**带回复规则提示（关键字留空时没有规则可提示，自然不写）。
- `replyKeywordCaseSensitive`：关键字匹配固定**不区分大小写**。

0.3.3 起以下六项**已删除**，回传不再有模式、窗口、条数上限或冷却（显式提交会按未知配置项拒绝）：

`replyMode`、`replyWindowMs`、`replyWindowStart`、`maxRepliesPerNotification`、`replyOnFailed`、`replyCooldownMs`。

老 `config.json` 里若还留着这些键，加载时原样保留但不生效；从面板保存时它们会被当成未知配置项拒绝。

`host` / `port` 在 World 启动时读取，改完要重启 World；面板保存后会在 `restartRequired` 时提示。其余项按通知现读。Windows 第一次监听非回环地址时可能弹出防火墙询问，需要放行该端口。

**令牌不进配置组**：配置只支持标量与二元数字数组，装不下令牌列表，所以令牌存在 `<dataDir>/worlds/notify-receiver/tokens.json`，只存 sha256 哈希与展示用前缀，由「令牌」面板增删改。WebUI「数据」页签里可以一键清除（等于吊销全部令牌，并断开所有连接）。

## 把回复转回 DSH

1. 在「令牌」面板点「新建令牌」，给这台设备起个名字，把**只显示一次的明文**复制走。
2. 在 DSH 插件的配置里填 `wsUrl`（例如 `ws://127.0.0.1:3210/ws`）和 `token`，打开 `enabled`。
3. 连上后「设备」面板能看到这台设备；默认 `replyKeywords: 回复,转给DSH`：用户以「回复」或「转给DSH」开头的消息会被转给 DSH，关键字会从正文里去掉。
4. 待回复不设过期时间、没有条数上限、也没有冷却：从通知到达起一直有效，直到下一条通知替换它、设备断开或 World 停止；这一轮里多条命中会**全部**按顺序转发。
5. DSH 处理完会再发一条任务完成通知回来，形成一轮一轮的对话；每一轮通知都替换成新的待回复绑定。
6. 把 `replyKeywords` 清空 = 关闭回传，只通知不转发。

每条转发的消息都带唯一的 `replyId`（`notificationId:消息游标`），DSH 用它去重，所以多条连续转发不会被当成重复。

多设备：

- 待回复绑定**发那条通知的设备**，只往那台设备发。
- 该设备断开时待回复随即失效；已排队但还没送达的回传会在重连后补发，离线超过 10 分钟就记 `reply-failed`。
- `deviceInText: auto` 时，只有两台以上设备同时在册，通知正文才会写「设备：…」。

## 从本机目录安装

1. 打开 Coopanion 设置窗口，点左栏底部的「高级模式」。
2. 打开「扩展」页，点「从本机目录安装」，在「扩展项目目录」里选择这个包目录（包含 `package.json` 的那一层）。
3. 装好后点「重启进程」。
4. 到「World 总览」打开「Notify Receiver」，在「服务」里确认发布地址与端口，在「令牌」里新建一个令牌。

扩展目录是本机目录时以 link 方式装入，改源码后重启进程即可看到效果。

## 开发

```bash
corepack pnpm install
pnpm test        # vitest
pnpm typecheck   # Node + WebUI 面板两套 tsconfig
pnpm verify:describe
pnpm build:webui # 改面板后重新生成 dist/webui.js
```

`cortico.webUiClient` 指向 `dist/webui.js`；安装/发布时这个文件必须在包里。只改 World 后端而不改面板时不需要重新构建。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`create()`、`describe` |
| `src/config.ts` | 配置段类型与默认值（不再声明 ConfigGroup） |
| `src/config-save.ts` | 面板保存的校验/夹取/默认值合并（纯函数） |
| `src/protocol.ts` | `dsh-notify.ws.v1` 帧类型、纯函数校验/编码、关闭码 |
| `src/tokens.ts` | 令牌表：`tokens.json` 读写、sha256 校验、生成/禁用/轮换/吊销 |
| `src/ws-server.ts` | `node:http` + `ws` 服务端：握手/鉴权、设备注册表、心跳、限流、背压 |
| `src/world.ts` | `World` 实现：事件投递、待回复绑定、离线回传队列、面板 `invoke`、状态工具 |
| `src/reply-policy.ts` | 关键字匹配与提示文本（纯函数） |
| `src/note.ts` | 通知体校验、截断与事件正文渲染（纯函数） |
| `src/webui/specs.ts` | 服务/回传规则字段声明与条件显示纯函数 |
| `src/webui/client.ts` | 服务/令牌/设备/回传规则面板 |
| `src/ENV_PROMPT.md` | 环境提示词模板：收到通知后怎么反应 |
| `dist/webui.js` | 构建产物，`cortico.webUiClient` 指向它 |
| `tests/` | 干装载、帧校验、令牌、WS 服务端、投递与回传 |

契约版本见 [docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md)：World 是 `cortico.api: 6`。

更多设计/排障/经验见本仓库 [docs/](docs/)：
- [架构](docs/ARCHITECTURE.md)
- [协议](docs/PROTOCOL.md)
- [WebSocket 设计](docs/WS-DESIGN.md)
- [开发](docs/DEVELOPMENT.md)
- [排障](docs/TROUBLESHOOTING.md)
- [经验总结](docs/LESSONS.md)

DSH 插件（`dsh-notify-sender`）侧的安装、配置与排障见其仓库的 README 与 `docs/`。

## 从改名前的版本升级（dsh-bridge → notify-receiver）

本扩展由 `cortico-world-dsh-bridge` 更名而来，内部标识一并改名，**旧配置与令牌不会自动迁移**：

| 旧 | 新 |
|---|---|
| World id `dsh-bridge` | `notify-receiver` |
| 配置段 `worlds.dsh-bridge.*` | `worlds.notify-receiver.*`（旧键不生效，需重配一遍） |
| 令牌表 `<dataDir>/worlds/dsh-bridge/tokens.json` | `<dataDir>/worlds/notify-receiver/tokens.json`（想保留令牌就把文件移过去） |
| 事件 `dsh-bridge.task` / `connected` / `disconnected` / `listening` / `replied` / `reply-failed` | `dsh-notify.*` |
| 协议 `dsh-bridge.ws.v1` | `dsh-notify.ws.v1` |
| 状态工具 `dsh_bridge_status` | `dsh_notify_status` |
| 显示名「DSH Bridge」 | 「Notify Receiver」 |

DSH 侧必须同步换成改名后的 `dsh-notify-sender`，旧协议（`dsh-bridge.ws.v1`）与新协议互不兼容。

## 隐私

扩展只接收 DSH 主动连上来发的通知，不读取 Coopanion 的记忆、对话或文件。令牌只以哈希落盘，面板与日志只显示前缀。默认只监听本机；要让别的设备连进来时必须有令牌，并且**不要**把端口直接暴露到公网——需要 `wss://` 时自行在前面加隧道或 HTTPS 反向代理。
