# 协议

两个方向共用**一条 WebSocket 连接**：Coopanion 的 World 是服务端，DSH 插件是客户端。DSH 主动连出去，因此只有 Coopanion 需要开端口；NSH 侧不再监听任何端口，也不需要配置回发地址。

| 项 | 值 |
|---|---|
| 传输 | WebSocket（RFC 6455），一条连接双工 |
| 端点 | `ws://<发布地址>:<端口>/ws`（默认 `ws://127.0.0.1:3210/ws`） |
| 健康检查 | 同端口的 `GET /health`（普通 HTTP） |
| 协议版本 | `dsh-notify.ws.v1`（帧里的 `v` 为 `1`） |
| 鉴权 | 握手头 `Authorization: Bearer <令牌>` 或首帧 `hello.token` |
| 帧上限 | 64 KiB；任务摘要 4000 字符；回传文本 8000 字符 |

> 0.3.0 起不再有 `POST /notify` 和 `POST /reply`。旧版本见本文末尾「从 v0.2 迁移」。

## 1. 连接与鉴权

1. 客户端用 `ws://…/ws` 发起升级；**可以**在握手时带 `Authorization: Bearer <令牌>`（`ws` 客户端支持自定义头，DSH 走这条）。
2. 连上后 **5 秒内**必须发 `hello`；超时服务端 `close(4408)`。
3. 令牌来源二选一：握手头，或 `hello.token` 字段。服务端用恒定时间比较校验哈希。
4. 失败与吊销：
   - 没有有效令牌 → `close(4401)`；
   - 令牌被禁用/删除，或该连接带了不受信的 `Origin` → `close(4403)`（已建立的连接会被主动断开）。
5. 连接建立时同 `deviceId` 的旧连接被顶掉：旧连接收到 `close(4409)`。
6. 在线设备数超过 `maxDevices` → 新连接 `close(4429)`。

**匿名本机模式**：一个可用令牌都没有、监听回环地址、且 `allowAnonymousLoopback` 打开时，允许不带令牌连接（仅本机调试）。监听非回环地址时必须有至少一个可用令牌，否则 World 拒绝启动。

**跨站防护**：握手请求带 `Origin` 头且不是本机页面 → 直接 `close(4403)`。防止浏览器里的恶意页面连上本机无令牌服务。

## 2. 帧格式

一帧一条 JSON（UTF-8 文本帧）。公共字段：

```json
{ "v": 1, "type": "<type>", "id": "<uuid>", "at": "2026-11-02T10:00:00.000Z" }
```

`id` 是发送方生成的帧 id（服务端用于关联 `ref`）；`at` 是发送时刻（ISO 8601）。未知 `type` 回 `error{code:"bad_frame"}` 并忽略该帧。

### 2.1 客户端 → 服务端

| `type` | 字段 | 说明 |
|---|---|---|
| `hello` | `deviceId` 必填、`deviceName`、`client`（`"dsh"`）、`clientVersion`、`features[]`、`token`（头部没带时必填） | 必须是第一帧 |
| `task` | `msgId`、`status`（`completed`/`failed`）、`title`、`text`、`sessionId`、`turn`、`durationMs`、`cwd` | 任务通知；服务端落库后回 `ack` |
| `reply-result` | `replyId`、`ok`（bool）、`error` | 注入结果 |
| `pong` | `ts` | 回应服务端 `ping` |
| `bye` | `reason` | 主动下线 |

`hello` 示例：

```json
{ "v": 1, "type": "hello", "id": "8d1c…", "at": "2026-11-02T10:00:00.000Z",
  "deviceId": "a1b2c3d4e5f6", "deviceName": "dev-box", "client": "dsh",
  "clientVersion": "0.3.0", "features": ["reply", "ack"] }
```

`task` 示例（字段与旧 HTTP 请求体一致，新增 `msgId`）：

```json
{ "v": 1, "type": "task", "id": "…", "at": "2026-11-02T10:00:00.000Z",
  "msgId": "5f2a…", "status": "completed", "device": "dev-box",
  "title": "修复登录页", "text": "测试全部通过", "sessionId": "session-…",
  "turn": 3, "durationMs": 65000, "cwd": "C:\\work\\app" }
```

字段限制：`title` ≤ 200、`text` ≤ 4000、`sessionId` ≤ 120、`cwd` ≤ 400、`deviceName` ≤ 80 字符；超长截断。`status` 也接受旧写法 `task.completed` / `task.failed`。

### 2.2 服务端 → 客户端

| `type` | 字段 | 说明 |
|---|---|---|
| `hello-ok` | `serverVersion`、`deviceId`、`heartbeatSec`、`limits{maxFrameBytes,maxReplyChars}` | 握手成功，可以发 `task` |
| `ack` | `ref`（= `msgId`）、`cursor`（事件库游标）、`duplicate?` | 已落库；`duplicate: true` 表示该 `msgId` 之前已落库 |
| `reply` | `replyId`、`taskId`、`sessionId`、`text`、`at` | 要求注入一条用户消息 |
| `ping` | `ts` | 每 `heartbeatSec` 一次 |
| `error` | `code`、`message`、`ref?` | `unauthorized` / `rate_limited` / `payload_too_large` / `bad_frame` / `not_ready` / `replies_disabled` |

`hello-ok` 示例：

```json
{ "v": 1, "type": "hello-ok", "id": "…", "at": "…", "serverVersion": "0.3.0",
  "deviceId": "a1b2c3d4e5f6", "heartbeatSec": 30,
  "limits": { "maxFrameBytes": 65536, "maxReplyChars": 8000 } }
```

`reply` 示例：

```json
{ "v": 1, "type": "reply", "id": "…", "at": "…", "replyId": "task-7f3a:42",
  "taskId": "task-7f3a", "sessionId": "session-…", "text": "把测试也跑一下" }
```

## 3. 时序

### 3.1 任务通知

```text
DSH                                        Coopanion World
 │ turn/end（completed / error）              │
 ├─ task{msgId,status,title,text,…} ────────►│ 校验 → pushEvent('dsh-notify.task')
 │◄──────────────── ack{ref:msgId,cursor} ───┤ 落库成功（Coo 排队说话）
 │ 收到 ack 才把这条从待发队列删掉             ├─ Coo 说完 → 开回复窗口（绑定 deviceId + sessionId）
```

### 3.2 用户回复

```text
用户在 Coo 那边按规则回复（默认「回复…」/「转给DSH…」）
 ├─ 匹配当前窗口 → reply{replyId,taskId,sessionId,text} ──► DSH
 │                                                          └─ prompt({sessionId, mode:'queue'})
 │◄──────────────── reply-result{replyId, ok:true} ─────────┤
 └─ ok:false / 断线 → 保留待发队列，重连后补发（最多 3 次或 10 分钟到期）
```

### 3.3 断线重连

```text
连接断开 → 客户端指数退避重连（1s → 30s，±20% 抖动）
  hello → hello-ok → 重发未 ack 的 task（同一 msgId；服务端按 msgId 去重）
                  → 服务端重发未 reply-result 的 reply（同一 replyId；DSH 按 replyId 去重）
```

## 4. 去重与确认语义

| 场景 | 键 | 谁负责 |
|---|---|---|
| 任务重复发送（重连重发/网络抖动） | `msgId` | 服务端：命中则回 `ack{duplicate:true}`，**不再落库**，去重表内存保留 10 分钟 / 最多 2000 条 |
| 回传重复投递 | `replyId` | 客户端：同一 `replyId` 只注入一次；注入失败**不**缓存，允许重发 |
| 通知本身的“同一轮只发一次” | `sessionId:turn`（插件内存） | 客户端：与协议无关，保持 v0.2 行为 |

`ack` 表示事件已写入事件库（有游标），不是“Coo 已经说完”。`reply-result` 表示注入结果，`ok:true` 才从待发队列删除。

## 5. 心跳与限流

- 服务端每 `heartbeatSec`（默认 30 秒）发 `ping`；客户端回 `pong`。连续 2 个周期没有 `pong` → 服务端断开。
- 客户端连续 2 个周期收不到 `ping` → 视为僵死连接，主动断开重连（Windows 睡眠唤醒后常见）。
- 客户端同时用 `ws.ping()` 做传输层探测，双保险。
- 限流：每设备默认 30 条 `task`/分钟（突发 10 条）。超限回 `error{code:"rate_limited"}` 并丢弃该帧；1 分钟内累计 3 次 → `close(1013)`。
- 背压：服务端待发数据超过 1 MiB → `close(1013)`（客户端退避重连）。

## 6. 关闭码

| 码 | 含义 | 客户端应对 |
|---|---|---|
| `1000` | 正常关闭（`bye` 或 World 停机） | 按 `enabled` 决定是否重连 |
| `1013` | 稍后重连（重启/背压/限流） | 退避重连 |
| `4401` | 令牌无效或缺失 | 按退避继续重试（日志提示检查令牌） |
| `4403` | 令牌已吊销 / `Origin` 不受信 | 按退避继续重试（日志提示令牌问题） |
| `4408` | 握手超时（没发 `hello`） | 立即重连一次 |
| `4409` | 同设备被新连接顶掉 | 不重连（那条新连接是“自己”） |
| `4413` | 单帧超限 | 缩短内容后重发 |
| `4429` | 设备数超限 | 退避重连 |

## 7. 健康检查

`GET /health`（HTTP，同端口）：

```json
{ "ok": true, "world": "notify-receiver", "protocol": "dsh-notify.ws.v1",
  "listening": true, "onlineDevices": 2 }
```

`listening` 为 false 或连接被拒时先看这里，再看令牌、地址、防火墙。

## 8. 兼容性约定

- 新增可选字段保持向后兼容；**新增必填字段属于破坏性变更**，需同时改姐妹仓库 `dsh-notify-sender` 并升版本。
- 未知帧类型忽略并回 `error{bad_frame}`；未知字段忽略。
- `cortico.api` 必须与 Coopanion 当前的 World 契约版本一致（当前 `6`）。
- 两侧版本需同代：0.3.x 只能和 0.3.x 通信（0.2 的 HTTP 协议已移除）。

## 9. 从 v0.2 迁移

| v0.2（HTTP） | v0.3（WebSocket） |
|---|---|
| DSH `endpoint`（`http://…/notify`） | `wsUrl`（`ws://…/ws`）；`wsUrl` 为空时自动从旧 `endpoint` 推导 |
| Coopanion `dshReplyEndpoint` | 删除（不再需要；旧键被忽略） |
| DSH `replyEnabled` / `replyHost` / `replyPort` | 删除（不再有入站服务） |
| Coopanion `token`（单令牌） | 令牌表 `tokens.json`，可多个、可吊销 |
| — | 新增 `heartbeatSec` / `maxDevices` / `allowAnonymousLoopback` / `deviceInText` / `announceConnections` |

升级顺序：先升 Coopanion（重启 World 后自动开始监听 `/ws`），再升 DSH（完全退出重开）。0.2 的 DSH 连不上 0.3 的 World，反之亦然——两边要一起升。

## 10. 用命令行调试

```powershell
# 健康检查
curl.exe -sS http://127.0.0.1:3210/health

# 用 ws 客户端手动握手 + 发一条任务（令牌换成你自己的）
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:3210/ws', { headers: { Authorization: 'Bearer <令牌>' } });
ws.on('open', () => ws.send(JSON.stringify({ v:1, type:'hello', id:'t1', at:new Date().toISOString(), deviceId:'debug', deviceName:'debug', client:'dsh', clientVersion:'0.3.0', features:['ack'] })));
ws.on('message', (m) => { console.log(String(m)); ws.send(JSON.stringify({ v:1, type:'task', id:'t2', at:new Date().toISOString(), msgId:require('crypto').randomUUID(), status:'completed', title:'调试', text:'hello' })); });
setTimeout(() => ws.close(), 3000);
"
```

调试连接会真的让 Coo 说话；不要拿生产会话 id 乱试。

## 11. 安全边界

- 网络入口只做“搬运”，不执行任意命令；回传最终变成一条用户消息。
- 令牌只存 sha256 哈希；面板只显示前缀；日志只打前缀。令牌明文只在生成时显示一次。
- 默认只监听回环；监听非回环必须至少有一个可用令牌；`Origin` 不受信一律拒绝。
- 不内置 TLS：跨公网请用 `wss://` + 隧道或反向代理（Caddy/Nginx 示例见 TROUBLESHOOTING）。
- 请求体/文本/帧都有上限；事件正文会截断，避免把巨量内容塞进提示词。
