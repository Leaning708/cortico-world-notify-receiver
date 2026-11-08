# WebSocket 双向桥设计（v0.3 提案）

本文是 **待确认** 的设计稿：把现在的「两条 HTTP 入口」改成「Coopanion 一侧的 WebSocket 服务端 + DSH 一侧的客户端」。
确认后本文并入 [PROTOCOL.md](PROTOCOL.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md)，再按第 9 节里程碑实施。

## 1. 为什么要改

| 现状（v0.2 HTTP） | 问题 |
|---|---|
| 两条入口各开一个端口（3210 / 3211） | 两台设备都要开入站端口，Windows 防火墙两边都要放行，反向那一侧（DSH）是被动方却不适合当服务器 |
| Coopanion 必须知道 DSH 地址（`dshReplyEndpoint`） | DSH 换 IP / 换端口 / 临时关机，Coo 侧就要改配置；跨设备时还要判断「哪台 DSH」 |
| 一次通知对应一次请求，没有连接状态 | 发失败只记日志；没重试、没确认、没在线状态；回传失败只能等下一轮 |
| 单令牌 | 多台设备共用一个令牌，吊销只能全断 |

改成的形态：

```
        ┌──────────────── Coopanion（Coo）────────────────┐
        │  Worlds.notify-receiver: WebSocket 服务端             │
        │  ws://<发布地址>:<端口>/ws   +  GET /health       │
        │  令牌表（多个）· 设备注册表 · 回复窗口             │
        └───────▲───────────────▲──────────────────────────┘
                │ ws             │ ws            （以后：其他 app / 手机 / 另一台 Coopanion）
        ┌───────┴──────┐  ┌─────┴────────┐
        │ DSH 本机      │  │ DSH 笔记本    │
        │ ws 客户端     │  │ ws 客户端     │
        └──────────────┘  └──────────────┘
```

**核心变化**：只有 Coopanion 需要开端口；DSH 变成「主动连出去」的一方，因此**不再需要配置回传地址**，也不受 NAT/防火墙影响。多设备天然就是多条连接。

### 不变量（不改的东西）

- Coo 仍然只把通知当外部事件说给用户听；正文只陈述事实，行为由 `ENV_PROMPT.md` 决定。
- 回复仍然要求「关键字/窗口/次数」匹配，默认「回复 / 转给DSH」前缀、Coo 说完起 60 秒、每条通知最多 1 条。
- 回传仍然只是注入一条**用户消息**（`sessionController.prompt`），不执行工具。
- 只传任务元数据与摘要，不读会话全文、附件、记忆、API Key。
- 不内置中继、不内置 HTTPS；跨公网自行加隧道/反向代理（WS 同样走 `wss://`）。
- `cortico.api` 仍是 `6`（不改契约，只改我们自己的协议）。

## 2. 传输与鉴权

- 单端口：`ws://<host>:<port>/ws` 升级 WebSocket；同一端口上保留 `GET /health`（纯 HTTP）用于排障。
- 实现：两侧都用 [`ws`](https://www.npmjs.com/package/ws)（成熟、处理分帧/掩码/ping-pong/背压/关闭码）。Coopanion 应用本身已经内置了 `ws`，但扩展不能跨目录解析，所以两个包各自声明依赖。
- 鉴权两种都收，**DSH 用第一种**：
  1. 握手头 `Authorization: Bearer <令牌>`（`ws` 客户端可以自定义请求头；URL 里不出现秘密）；
  2. 首帧 `hello.token`（浏览器/其他语言的客户端发不了自定义头时用）。
- 连接建立后 5 秒内必须收到 `hello`，否则 `close(4408)`。
- 令牌不存在/不匹配 → `close(4401)`；令牌被禁用或删除 → 服务端主动 `close(4403)`。
- **跨站防护**：握手带 `Origin` 且不是本机页面的一律拒绝（`close(4403)`）。否则恶意网页可以在你开着无令牌本机模式时直接连 `ws://127.0.0.1:3210`。
- 帧上限 64 KiB（`maxPayload`），回传文本 ≤ 8000 字符，任务摘要 ≤ 4000 字符，与现在一致。

## 3. 协议 `dsh-notify.ws.v1`

一帧一条 JSON（UTF-8 文本帧），公共字段：

```json
{ "v": 1, "type": "<type>", "id": "<uuid>", "at": "<ISO8601>" }
```

### 3.1 客户端 → 服务端

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `token?` `deviceId` `deviceName` `client`（`"dsh"`）`clientVersion` `features[]` | 必须是第一帧；`deviceId` 稳定标识一台机器 |
| `task` | `msgId` `status`（`completed`/`failed`）`title` `text` `sessionId` `turn?` `durationMs?` `cwd?` | 任务通知；服务端落库后回 `ack` |
| `reply-result` | `replyId` `ok` `error?` | DSH 注入用户消息的结果 |
| `pong` | — | 回应服务端 `ping` |
| `bye` | `reason?` | 主动下线（插件停用/退出时发） |

### 3.2 服务端 → 客户端

| type | 字段 | 说明 |
|---|---|---|
| `hello-ok` | `serverVersion` `deviceId` `heartbeatSec` `limits{maxFrameBytes,maxReplyChars}` | 握手成功 |
| `ack` | `ref`（= `msgId`）`cursor` `duplicate?` | 已落库（`duplicate: true` 表示按 `msgId` 去重命中） |
| `reply` | `replyId` `taskId` `sessionId` `text` `at` | 要求 DSH 注入一条用户消息 |
| `ping` | `ts` | 每 `heartbeatSec` 一次；连续 2 次无 `pong` 断开 |
| `error` | `code` `message` `ref?` | `unauthorized` / `rate_limited` / `payload_too_large` / `bad_frame` / `not_ready` |

### 3.3 关闭码

| 码 | 含义 |
|---|---|
| `1000` | 正常关闭（`bye` 或 Coopanion 停机前的礼貌关闭） |
| `1013` | 稍后重连（重启 World / 背压 / 触发限流） |
| `4401` | 令牌无效 |
| `4403` | 令牌已吊销 / Origin 不受信 |
| `4408` | 握手超时（没发 `hello`） |
| `4409` | 同 `deviceId` 的新连接顶掉了这条旧连接 |
| `4413` | 单帧超限 |
| `4429` | 设备数超过 `maxDevices` |

### 3.4 时序

**任务通知**

```
DSH                                    Coopanion
 │ turn/end（completed / error）          │
 ├── task{msgId,status,title,text,...} ──►│ 校验 → pushEvent('dsh-notify.task')
 │◄────────────── ack{ref:msgId,cursor} ──┤ 落库成功
 │   （收到 ack 才从待发队列里删除）        ├─ Coo 说话 → 开回复窗口(绑定 deviceId)
```

**用户回复**

```
Coo 说完 ──► 窗口开始（默认 60s，绑定这条通知的设备 + 会话）
用户「回复：把测试跑一下」
 ├─ 匹配 → reply{replyId,taskId,sessionId,text} ──► DSH
 │                                        │        └─ prompt({sessionId, mode:'queue'})
 │◄──────────────── reply-result{replyId,ok} ──────┤
 └─ ok=false → 保留待发队列，下次连接重发（最多 3 次，或离线 TTL 到期）
```

**断线重连**

```
连接断开 → 指数退避重连（1s→2s→4s…上限 30s，±20% 抖动）
重连后：hello → hello-ok → 重发未 ack 的 task（同一 msgId）→ 服务端去重返回 ack{duplicate:true}
                          → 服务端重发未 reply-result 的 reply
```

## 4. Coopanion 侧（World 扩展）

### 4.1 配置项

**服务（发布）** — 改 `host`/`port` 后要重启 World：

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.notify-receiver.host` | `127.0.0.1` | 对外发布地址；给局域网连就填 `0.0.0.0` 或本机网卡地址 |
| `worlds.notify-receiver.port` | `3210` | 发布端口 |
| `worlds.notify-receiver.heartbeatSec` | `30` | 心跳间隔（10–300） |
| `worlds.notify-receiver.maxDevices` | `8` | 同时在线设备上限（1–64） |
| `worlds.notify-receiver.allowAnonymousLoopback` | `true` | 没有任何令牌时，是否允许本机匿名连接（调试用） |
| `worlds.notify-receiver.deviceInText` | `auto` | 通知正文里写不写设备名：`auto`（多设备才写）/`always`/`never` |
| `worlds.notify-receiver.announceConnections` | `true` | 设备上线/下线是否让 Coo 说一句（已确认：默认说） |

**回传规则 / 高级** — 保持现状，不新增不删除（`replyMode`、`replyWindowMs`、`replyKeywords`、`maxRepliesPerNotification`、`replyWindowStart`、`replyKeywordMatch`、`replyKeywordCaseSensitive`、`stripKeyword`、`replyOnFailed`、`ignorePetAnswers`、`replyCooldownMs`、`showReplyHint`）。

**新增一个高级项**：`worlds.notify-receiver.offlineReplyTtlMs` 默认 `600000`（10 分钟）——设备离线时，回传消息最多等这么久。

**删除**：`worlds.notify-receiver.dshReplyEndpoint`（不再需要；旧配置里的键直接忽略）。

### 4.2 令牌

- 存储：`<dataDir>/worlds/notify-receiver/tokens.json`（`ctx.dataDir`），**只存哈希**，不存明文：
  ```json
  { "version": 1, "tokens": [
    { "id": "tok_7f3a", "label": "家里台式机", "algo": "sha256",
      "hash": "…", "prefix": "cwb_9f3a", "createdAt": "…",
      "lastUsedAt": null, "enabled": true }
  ] }
  ```
  为什么不在 ConfigGroup 里：Cortico 的配置只支持标量与二元数字数组，塞不下结构化列表；面板通过 `invoke(method, args)` 做增删改。
- 明文格式 `cwb_` + 32 字节 base64url，**生成时只显示一次**（面板里可复制），之后只显示 `prefix`。
- 面板动作：新建（输入标签 → 弹一次明文）、启用/禁用、删除、轮换（删旧建新）。
- 生效即时：令牌被禁用/删除 → 用它认证的连接立刻 `close(4403)`。
- 存储声明为可清除项（WebUI「数据」页签），清除 = 吊销全部令牌。
- 启动规则：监听非回环地址且**没有可用令牌**时拒绝启动（同现在的规则，只是把「单令牌」换成「令牌表非空」）。

### 4.3 设备注册表

内存 `Map<deviceId, Connection>`，每条保存：`deviceId`、`deviceName`、`tokenId/label`、`client`/`clientVersion`、`connectedAt`、`lastSeenAt`、收到条数、待发回传队列。

- 同 `deviceId` 新连接 → 旧连接 `close(4409)`（笔记本换网、睡眠唤醒常见）。
- 在线设备超过 `maxDevices` → 新连接 `close(4429)`。
- 事件 `senderKey` = `dsh:<deviceId>`（原来是 `dsh:<device>`）。

### 4.4 回复窗口改造

`PendingReply` 从「只有 `sessionId` + 固定 `endpoint`」改成：

```
{ deviceId, taskId, notificationId, cursor, remaining, expiresAt, windowStart, waitingForCoo, queue: Map<replyId, {text, at, attempts}> }
```

- 匹配逻辑（`reply-policy.ts`）**完全不动**。
- 命中后不再 `POST /reply`，而是走该 `deviceId` 的连接：在线直接发 `reply`；离线进 `queue`，重连后补发，TTL 到期记一条 `dsh-notify.reply-failed`。
- 新通知仍然覆盖旧窗口（保持现在的简单语义；多设备时每个窗口各自绑定自己的设备）。

### 4.5 面板与状态

World 页页签（现在 5 个 → 7 个）：

| 页签 | 内容 |
|---|---|
| 服务（新） | 发布地址/端口、心跳、设备上限、匿名本机开关、当前监听状态、可复制的 `ws://<ip>:<port>/ws`、局域网地址建议 |
| 令牌（新） | 令牌列表 + 新建/禁用/删除/轮换；只显示前缀与最近使用时间 |
| 设备（新） | 在线/离线设备（名称、令牌标签、客户端版本、连接时长、收到条数、待发回传数），可「断开」 |
| 回传规则 | 不变 |
| 高级 | 原高级项 + `offlineReplyTtlMs` / `deviceInText` / `announceConnections` |
| 配置 | 框架生成的原始表单（兜底，不含令牌） |
| 环境提示词 | 微调：多设备时按正文写的设备名区分 |

状态灯与徽标：`服务器`（online/error/offline）、`客户端 N`（online/offline）。徽标：在线设备数、可用令牌数。

`dsh_notify_status` 工具输出改造（示例）：

```
接收端：ws://0.0.0.0:3210/ws（监听中）
令牌：2 个（1 个使用中）
设备：2 在线
  · 家里台式机（dsh 0.3.0｜令牌「家用」）已连 12 分钟，收到 8 条，待发回传 0
  · 公司笔记本（离线，最近 14:02，令牌「公司」）
待回复：家里台式机 / 会话「修复登录页」，剩 42 秒，最多再转 1 条
已转发：5 条；最近错误：…
```

### 4.6 新增事件

| 事件 | deliver | 用途 |
|---|---|---|
| `dsh-notify.connected` / `dsh-notify.disconnected` | `true`（`announceConnections` 关闭时 `false`） | 观测 + Coo 播报 |
| `dsh-notify.reply-failed` | `false` | 回传最终失败（离线超时/重试耗尽） |
| `dsh-notify.listening` / `dsh-notify.task` / `dsh-notify.replied` | 保持现状 | — |

## 5. DSH 侧（Host 插件）

### 5.1 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关（打开才连） |
| `wsUrl` | `ws://127.0.0.1:3210/ws` | Coopanion 的发布地址；跨设备填 `ws://192.168.x.x:3210/ws` |
| `token` | 空 | 与 Coo 侧某个令牌一致（secret 字段，留空表示不改） |
| `device` | 空 | 显示名；留空用主机名 |
| `deviceId` | 空 | 稳定 id；留空 = 主机名的 12 位哈希（同机重装不变） |
| `notifyOnCompleted` / `notifyOnFailed` / `includeSubagents` / `notifyMode` / `minTurnMs` / `maxSummaryChars` | 同现在 | 通知判定逻辑不变 |
| `acceptReplies` | `true` | 是否接受 Coo 转回的消息 |
| `connectTimeoutMs` | `8000` | 握手超时 |
| `reconnectMinMs` / `reconnectMaxMs` | `1000` / `30000` | 重连退避区间 |
| **删除** | `endpoint`、`timeoutMs`、`replyEnabled`、`replyHost`、`replyPort` | 不再有入站服务 |

升级兼容：`wsUrl` 为空时，从旧的 `endpoint` 推导（`http://host:port/notify` → `ws://host:port/ws`），并在日志里提示迁移。

### 5.2 连接管理（`lib/ws-client.js` 新文件）

- 状态机：`idle → connecting → hello → ready → closing → backoff`。
- 退避：1s×2ⁿ 封顶 30s，±20% 抖动；`hello-ok` 后归零。
- 心跳：按 `hello-ok.heartbeatSec` 回 `pong`；连续 2 次收不到 `ping` 视为僵死连接（Windows 睡眠唤醒的典型症状），主动重连。
- 应用层 ping 不够时，同时开 `ws` 原生 ping（`ws.ping()`），双保险。
- `enabled` 关闭 / 插件卸载 / profile 退出：发 `bye` 再 `close(1000)`，走 `ctx.effect` 清理。

### 5.3 发送队列与确认

- `notify.js` 仍然产出 payload，但增加 `msgId = randomUUID()`。
- 队列（内存，上限 50 条 / TTL 10 分钟）：`task` 入队 → 发送 → 等 `ack` → 出队。
- 未连接时也入队（现在是直接丢弃），连上后按序补发；重连重发用同一 `msgId`，服务端去重。
- 通知判定（`shouldNotify`、`seen` 去重、`minTurnMs`、`notifyMode` 三档、goal 状态播种）**全部不动**。

### 5.4 回传注入

- 收 `reply` → `sessionController.prompt({ sessionId, mode:'queue', content:[{type:'text',text}] })` → 回 `reply-result`。
- 去重键沿用 `replyId`（同一 `replyId` 只注入一次），失败时**不**缓存键，允许服务端重发。
- `acceptReplies: false` → 直接回 `reply-result{ok:false,error:'replies disabled'}`，让 Coo 侧按策略记 `reply-failed`。
- 删掉 `lib/reply-server.js`（213 行）和入站端口绑定 → 不再有 3211、不再需要防火墙放行。

### 5.5 Client 半（配置卡片）

字段按 5.1 重排：地址/令牌/设备名一页，「通知时机」一页，「高级」一页；加一个只读状态行（连接状态、最近 ack、待发条数）。仍然需要重启 DSH 一次才扫描到（框架限制，不变）。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `src/ws-server.ts` | **新增**：`ws` 服务端、握手/鉴权、设备注册表、心跳、限流、背压、关闭码 |
| `src/protocol.ts` | **新增**：帧类型、纯函数校验/编解码、错误码 |
| `src/tokens.ts` | **新增**：`tokens.json` 读写、哈希校验、增删改、轮换 |
| `src/world.ts` | 改造：`start/stop` 换成 ws 服务；`openReplyWindow`/`forwardMatches` 按设备路由；`invoke` 支持 `tokens.*`/`devices.*`；`statusText` 重写；`/health` 保留 |
| `src/config.ts` | 删 `dshReplyEndpoint`，加 4.1 的新键与 ConfigGroup |
| `src/webui/client.ts` | 加「服务 / 令牌 / 设备」三个 panel（含带参 `invoke`） |
| `src/reply-policy.ts` / `note.ts` | 基本不动（`note.ts` 只加设备名渲染的 `auto/always/never`） |
| `package.json` | 加 `ws` 依赖；版本 0.3.0；`describe.json` 随事件/工具更新 |
| `dsh-notify-sender/lib/ws-client.js` | **新增**：连接、握手、退避、心跳、发送队列、回传分发 |
| `dsh-notify-sender/lib/reply-server.js` | **删除** |
| `dsh-notify-sender/lib/notify.js` | `endpoint` → `wsUrl` 校验；加 `msgId`；其余纯逻辑不动 |
| `dsh-notify-sender/index.js` | 接 ws 客户端生命周期；删 HTTP 服务；配置项重排 |
| `dsh-notify-sender/lib/client.js` | 配置卡片字段重排 + 状态行 |
| `docs/PROTOCOL.md` / `ARCHITECTURE.md` / `DEVELOPMENT.md` / `TROUBLESHOOTING.md` | 按新协议重写对应章节 |
| `CHANGELOG.md`（两份）、两个 README | 0.3.0 迁移说明 |

> 本表按当年 monorepo 视角写成。现在 `dsh-notify-sender` 已拆为姐妹仓库，其文件路径相对其仓库根。

## 7. 测试计划

| 层 | 用例 |
|---|---|
| 协议纯函数 | 帧校验（缺字段/超长/未知 type）、版本不符、关闭码映射 |
| 令牌 | 生成/哈希校验、禁用后拒绝、删除后断开、轮换、匿名本机模式、非回环无令牌拒绝启动 |
| WS 服务端 | 头部鉴权、`hello.token` 鉴权、5s 握手超时、同 `deviceId` 顶号、`maxDevices`、恶意 `Origin`、64KiB 超限、限流 |
| 投递 | `task` → 事件正文/元数据、`ack.cursor`、`msgId` 重复只落库一次、断线重发 |
| 回传 | 窗口匹配后按设备路由、设备离线排队、重连补发、`reply-result` 失败重试 3 次/TTL、`acceptReplies=false` |
| DSH 客户端 | 握手/退避/心跳超时重连、`enabled` 关闭 `bye`、队列在断线期间不丢、`ack` 后出队、`replyId` 去重注入 |
| 回归 | 现有 34 + 28 个测试里与通知判定/回复策略/事件渲染相关的全部保留 |

## 8. 风险与降级

| 风险 | 处理 |
|---|---|
| `ws` 依赖安装（本机 registry 抖动过） | 先在两个包目录 `pnpm add ws` 试装；不可用则改用内置实现（服务端约 250 行 RFC6455 子集 + 客户端用 Node 22+ 全局 `WebSocket`），接口不变 |
| 长连接占用 / 睡眠唤醒僵死 | 30s 应用层心跳 + 原生 ping + 2 次超时重连 |
| 令牌泄漏 | 只存哈希；面板只显示前缀；日志只打前缀；`wss` 由隧道/反代提供 |
| 端口暴露 | 默认回环；非回环必须有令牌；`Origin` 白名单；跨公网要求自行加隧道 |
| 多设备回复错会话 | 回复窗口绑定 `deviceId + sessionId`；正文多设备时写明设备名 |
| 升级不同步（新 Coo + 旧 DSH） | 见第 9 节「干净切换」决策 |

## 9. 里程碑（确认后执行）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 协议模块 + WS 服务端骨架 + DSH 客户端骨架（只做 hello/task/ack） | 两侧单测通过；本机 ws 连通、`task` 落事件库 |
| M2 | 令牌表 + 服务/令牌/设备面板 + `dsh_notify_status` v2 | 面板可建/禁/删令牌；吊销即时断连；状态灯正确 |
| M3 | 回传闭环按设备路由 + 离线排队 + 重试 | 断网重连后回传仍送达；`reply-failed` 事件正确 |
| M4 | 退役 HTTP：删 `reply-server.js`、删 `dshReplyEndpoint`、`/notify` 按决策处置 | 3211 不再监听；旧配置键被忽略 |
| M5 | 文档/版本/归档：0.3.0、CHANGELOG、README、迁移说明、本机端到端 | 两侧测试全绿；两台「设备」（可用两个 deviceId 模拟）并行不串会话 |

## 10. 已确认的决策（2026-11-02）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 令牌存哪里 | `<dataDir>/worlds/notify-receiver/tokens.json`，只存 sha256 哈希（ConfigGroup 装不下列表） |
| 2 | 旧 HTTP `POST /notify` 与 `dshReplyEndpoint` | 干净切换：0.3.0 直接删；`GET /health` 保留 |
| 3 | 设备上线/下线要不要让 Coo 说话 | 默认说（`announceConnections: true`），可关 |
| 4 | 是否给「其他 app」预留多协议 | 只定义 `client: "dsh"`，字段留 `features` 与 `client` 便于扩展 |
| 5 | 是否需要 TLS | 不内置，文档给 Caddy/Nginx 的 `wss` 示例 |
| 6 | 令牌是否绑定设备 | 不绑定：令牌是凭据，设备由 `hello.deviceId` 识别 |

## 11. 实施记录（0.3.0 实际落地）

按第 9 节 M1–M5 全部落地。两侧测试 84（Coopanion）+ 42（DSH）全绿，本机端到端验收通过。

### 已接受的实现偏差（不影响帧形状与关闭码）

| 项 | 设计稿 | 实际 | 原因 |
|---|---|---|---|
| 传输层 `maxPayload` | 64 KiB | 128 KiB（协议判定仍是 64 KiB） | 先自己回 `error{payload_too_large}` 再 `close(4413)`；>128 KiB 由 `ws` 以 1009 断开，拿不到 4413 |
| ConfigGroup | service / reply / advanced 三组 | 同（令牌与设备不进配置组） | ConfigGroup 只支持标量与二元数字数组 |
| 离线回传队列 | `PendingReply.queue` | World 层 `replies: Map<replyId, QueuedReply>` | 新通知覆盖窗口时不该丢掉已排队的回传 |
| `reply-result` 失败重发间隔 | 未规定 | 250 ms，最多 3 次（含首发） | — |
| `devices.kick` 关闭码 | 未规定 | `1013`（让客户端自行重连） | — |
| 被顶号（4409） | 未规定 | 不发 `disconnected` 事件 | 避免 Coo 播报噪声 |
| 心跳/匿名阈值下限 | 配置 10s | 内部允许 <10s（仅测试注入） | 让测试能跑 50ms 心跳 |
| `@types/ws` | — | 新增 devDependency | `ws` 不自带类型 |

### 本机验收（2026-11-02，Coopanion 0.2.16 / DSH desktop profile）

| 项 | 结果 |
|---|---|
| World 加载 | 扩展 0.3.0 `loaded`，World `notify-receiver` active，只听 `127.0.0.1:3210`（3211 已消失） |
| `/health` | `{"ok":true,"world":"notify-receiver","protocol":"dsh-notify.ws.v1","listening":true,"onlineDevices":1}` |
| 真实 DSH 连接 | `hello` 握手成功，设备 `DESKTOP-KV9I0B1`，令牌「本机 DSH」，`clientVersion 0.3.0` |
| `task` → `ack` | `ack{ref, cursor=92, duplicate=false}` |
| 同一 `msgId` 重发 | `ack{duplicate:true}`，游标未推进（没有重复落库） |
| 心跳 | 收到 `ping`，回 `pong` 后连接保持 |
| 坏令牌 | `close(4401)` |
| 令牌吊销 | 停用后连接被 `close(4403)`（reason「令牌已停用或删除」） |
| 外来 `Origin` | `close(4403)` |
| 回传闭环 | 控制台注入「回复 测试回传」→ 收到 `reply{text:"测试回传", replyId:"…:112"}`，关键字已剥离、路由到发起通知的设备 |
| 设备播报 | `dsh-notify.connected` / `disconnected` 事件按 `announceConnections` 投递并唤醒 Coo |

### 遗留

- `msgId` 去重表、发送队列、回传队列都在内存：任一侧进程重启后需要重发/重试才会补上（幂等键已保证不重复注入）。
- 背压保护已实现但没有用例。
- 面板只经过 typecheck + esbuild + manifest 验证，没有浏览器自动化测试。
- DSH 配置卡片里的「连接状态」只读行没做：Client 半拿不到 Host 侧状态，暂以日志与 Coo「设备」页签代替。
### 11.1 0.3.1 增量（配置层，不动协议）

- Coopanion：不再声明 ConfigGroup（「配置」页签因此消失），保存改走 `invoke('config.save')` → `WorldContext.persist()`；「高级」页签并入「服务」「回传规则」；回传规则按 `replyMode` 条件显示（`webui/specs.ts` 的 `when`），保存跳过隐藏字段。
- DSH：配置卡片分「连接/通知/高级」页签；`servers` 数组支持保存多个 ws 服务并单选启用（只连启用的那条，切换即重连），旧 `wsUrl`/`token` 作为迁移来源保留。
- 协议帧、关闭码、去重语义**未变**，0.3.0 与 0.3.1 可互连；`hello.clientVersion` 与 `hello-ok.serverVersion` 变成 `0.3.1`。
### 11.2 0.3.2 增量（配置精简，不动协议）

- Coopanion：删除 `ignorePetAnswers`（固定不忽略）、`offlineReplyTtlMs`（固定 10 分钟常量）、`showReplyHint`（固定总是写）、`replyKeywordCaseSensitive`（固定大小写不敏感）；回传规则面板变短，旧的这 4 个键留在 config.json 但不再生效，显式提交会被拒绝。
- DSH：删除 `includeSubagents`（子代理固定不通知，turn/goal 统一走 `isSubagentSession`）；配置卡片页签样式修正（选中态=底部主色条，非选中无边框，点击不留黑框，键盘才显示聚焦环）；服务列表改成表头 + 单行/服务的紧凑布局；连接页签顺序改为「本机 → 接受回传 → 服务列表」，全局 `enabled` 常驻在页签条上方。
- 协议帧、关闭码、去重语义仍未变。
### 11.3 0.3.3 增量（回传策略简化，不动协议）

- Coopanion：删除 `replyMode`/`replyWindowMs`/`replyWindowStart`/`maxRepliesPerNotification`/`replyOnFailed`/`replyCooldownMs`；回传只剩关键字匹配，待回复绑定**不过期、不设条数上限、无冷却**，只在「下一条通知替换/设备断开/World 停止」时失效；关键字留空即关闭回传。`onEventsSettled` 的窗口计时职责删除。
- DSH：卡片简介精简、字段解释改为 `InfoDot` 悬浮提示、删除 `settings.plugins.tab` 注册。
- 协议帧、关闭码、去重语义仍未变。