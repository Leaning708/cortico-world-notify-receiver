# Changelog

## 改名归档（0.3.3 之后，未发布版本号）

项目由 `cortico-world-dsh-bridge` 更名为 `cortico-world-notify-receiver`，与 DSH 插件 `dsh-notify-sender`（原 `dsh-cortico-world-bridge`）分家为两个独立仓库。内部标识同步改名：World id `dsh-bridge` → `notify-receiver`、事件 `dsh-bridge.*` → `dsh-notify.*`、协议 `dsh-bridge.ws.v1` → `dsh-notify.ws.v1`、配置段 `worlds.dsh-bridge` → `worlds.notify-receiver`、令牌表 `<dataDir>/worlds/dsh-bridge/` → `<dataDir>/worlds/notify-receiver/`、状态工具 `dsh_bridge_status` → `dsh_notify_status`、显示名「DSH Bridge」→「Notify Receiver」。旧配置、旧令牌路径与旧协议不互认，迁移说明见 README。monorepo 的根级 README/CHANGELOG/CONTRIBUTING/docs 按归属拆入两个仓库。

## 0.3.3

- **回传简化为纯关键字**：删除 6 个配置项 —— `replyMode`、`replyWindowMs`、`replyWindowStart`、`maxRepliesPerNotification`、`replyOnFailed`、`replyCooldownMs`。不再有回传模式、时间窗口、转发条数上限或冷却；显式提交这些键会按未知配置项拒绝。
- 新语义：通知（**completed 与 failed 一样**）到达时，若设备在线、有 `sessionId`、关键字非空，就建立一个待回复绑定（`deviceId + sessionId + cursor`）。它**不设过期时间、不设转发条数上限、无冷却**，一直有效到被下一条通知替换、设备断开或 World 停止。
- 每轮结束时从 `cursor` 之后按游标顺序扫描用户消息（`console.message` 的 `meta.body`、`desktop-pet.message` 的 `meta.text`），命中的**全部**转发；每成功一条推进 cursor，同一条不会转两次。关键字留空 = 不转发（等价于关闭回传）。
- 删除 `windowStart` / `coo_said` 计时与 `onEventsSettled` 的窗口职责（该方法整个删除）；`PendingReply` 去掉 `expiresAt` / `remaining` / `windowStart` / `waitingForCoo` / `cooDelivered` / `lastForwardAt`。
- 回复提示文案只讲关键字（例如「回复规则：以「回复」或「转给DSH」开头的消息会转给 DSH；关键字会从转发内容里去掉。」），不再出现时间与条数。
- 面板：回传规则页只剩 `replyKeywords` / `replyKeywordMatch` / `stripKeyword`，删除按模式条件显示与「回传已关闭」说明；关键字字段说明写明留空等于关闭回传。
- 状态工具与设备面板不再显示「剩 N 秒 / 最多再转 N 条」，只显示「待回复：设备 / 会话」。
- 同步：`config.ts`、`config-save.ts`、`webui/specs.ts`、`reply-policy.ts`（删 `clampReplyWindow` / `clampMaxReplies` 与模式分支）、`world.ts`、`ENV_PROMPT.md`、`describe.json`、`definition.ts` 事件描述。
- 版本号 0.3.3（`SERVER_VERSION` 同步），重新构建 `dist/webui.js`。
- 测试：111 个 vitest（删掉窗口/条数/冷却/off/both 用例；补 failed 通知也开窗、同轮多条全部按序转发、关键字留空不转发、消息时间推进很久仍转发、下一条通知替换、设备断开后失效；排队补发与离线 TTL 用例按新状态机改写后保留）。

## 0.3.2

- **删除 4 个配置项并固定行为**（不再可配）：
  - `ignorePetAnswers`：固定**不忽略** —— pet_ask 的 `[answer]` 回答照常当用户消息参与回复匹配，删除 `world.ts` 里跳过它们的逻辑。
  - `offlineReplyTtlMs`：固定 10 分钟，写成模块常量 `OFFLINE_REPLY_TTL_MS = 600_000`；离线超过该时长仍记 `dsh-notify.reply-failed`。
  - `showReplyHint`：固定**总是写**回复规则提示，删掉开关与相关条件分支（回传关闭时没有窗口，自然不写）。
  - `replyKeywordCaseSensitive`：固定**不区分大小写**，`matchReplyText` 不再接受大小写参数，正则匹配恒带 `i`。
- 同步清理：`src/config.ts` 类型与默认值、`src/config-save.ts` 白名单/枚举/夹取、`src/webui/specs.ts` 回传规则字段、`src/world.ts` 里的读取。面板保存时这四个键现在按未知配置项拒绝。
- 老 `config.json` 里若还留着这四个键，加载时原样保留但不生效；从面板保存时不会写回。
- 版本号 0.3.2（`SERVER_VERSION` 同步），重新构建 `dist/webui.js`。
- 测试：112 个 vitest（新增“pet_ask 回答照常参与匹配”“关键字固定大小写不敏感”“提示总是写”与删除键按未知键拒绝的用例）。

## 0.3.1

- **隐藏「配置」页签**：World 不再声明 `ConfigGroup`，框架因此不生成原始配置表单；面板保存改走 `invoke('config.save', [patch])`，由 World 侧校验、夹取后调用 `WorldContext.persist`。删除 World 侧的配置组声明与 `configOptions`。
- **删除「高级」页签**：字段并入「服务」（`host`/`port`/`heartbeatSec`/`maxDevices`/`allowAnonymousLoopback`/`deviceInText`/`announceConnections`）与「回传规则」（全部 `reply*` + `offlineReplyTtlMs`）。World 页最终为 服务 / 令牌 / 设备 / 回传规则 + 环境提示词。
- **回传规则条件显示**：按 `replyMode` 隐藏无关字段——`off` 只留判定方式并提示「回传已关闭：DSH 只发通知，不接收回复」；`window` 隐藏关键字组；`keyword` 全部显示且窗口字段改称「窗口安全上限（0 = 不限时）」；`both` 全部显示。控件与说明一起隐藏，保存时跳过不可见字段。
- **保存校验**：未知键拒绝、枚举校验、字符串 trim、数值夹取（端口 0–65535、心跳 10–300、设备 1–64、窗口 0–600000、次数 1–10、冷却 0–60000、离线 TTL 0–86400000）；`host`/`port` 变化时返回 `restartRequired`，面板提示重启 World。
- 面板 `state` 在没有 ConfigGroup 后仍返回全部字段（缺字段补默认值）；版本号 0.3.1。
- 测试：107 个 vitest（新增 `config.save` 校验/夹取/未知键/persist、`restartRequired`、隐藏字段不写、四种模式可见键集合、页签列表）。

## 0.3.0

- **HTTP 入口改为 WebSocket 服务端**：`ws://<host>:<port>/ws` 升级（`ws` 的 `noServer`），同端口保留 `GET /health`；删除 `POST /notify` 与 `dshReplyEndpoint`。
- 协议 `dsh-notify.ws.v1`（见 [docs/WS-DESIGN.md](docs/WS-DESIGN.md) 第 3 节）：`hello` / `task` / `reply-result` / `pong` / `bye`，服务端回 `hello-ok` / `ack` / `reply` / `ping` / `error`；关闭码 1000 / 1013 / 4401 / 4403 / 4408 / 4409 / 4413 / 4429。
- 令牌表：`<dataDir>/worlds/notify-receiver/tokens.json`，**只存 sha256 哈希**，明文 `cwb_` + 32 字节 base64url 只显示一次；面板可新建 / 启用停用 / 删除 / 轮换，停用或删除时相关连接立刻 `close(4403)`。删除配置项 `worlds.notify-receiver.token`。
- 设备注册表：按 `hello.deviceId` 认设备，同 id 顶号（`4409`）、超过 `maxDevices` 拒绝（`4429`）、设备上下线事件、面板可断开某台设备。
- 握手与传输防护：头部 `Authorization: Bearer` 或首帧 `hello.token` 鉴权、5 秒 `hello` 超时（`4408`）、64 KiB 帧上限（`4413`）、按设备限流、背压检查、带非本机 `Origin` 的握手一律 `4403`；非回环地址且没有可用令牌时拒绝启动。
- 心跳：`heartbeatSec`（默认 30）发 `ping` + `ws` 原生 ping，连续 2 次无回应断开；`allowAnonymousLoopback` 只在没有任何可用令牌时放行本机匿名连接。
- 回传改造：回复窗口绑定 `deviceId`，命中后走该设备连接；设备离线进队列、重连补发，`reply-result` 失败最多重发 3 次，离线超过 `offlineReplyTtlMs` 或重试用尽记 `dsh-notify.reply-failed`（不唤醒）。
- 新事件：`dsh-notify.connected` / `dsh-notify.disconnected`（受 `announceConnections` 控制是否投递）、`dsh-notify.reply-failed`（只落库）。
- 新配置项：`heartbeatSec`、`maxDevices`、`allowAnonymousLoopback`、`deviceInText`（`auto`/`always`/`never`）、`announceConnections`、`offlineReplyTtlMs`。
- World 页拆成「服务 / 令牌 / 设备 / 回传规则 / 高级」五个面板 + 原始「配置」+「环境提示词」七个页签；状态灯改为「服务器」「客户端 N」，徽标显示在线设备数与可用令牌数。
- `dsh_notify_status` 输出重写：接收端地址与监听状态、令牌数、设备列表（在线/离线、客户端版本、令牌标签、连接时长、收到条数、待发回传）、待回复窗口、已转发与最近错误。
- 令牌表声明为可清除存储（WebUI「数据」页签），清除等于吊销全部令牌。
- 测试：83 个 vitest（帧校验、令牌、WS 服务端握手/顶号/上限/Origin/超限/限流/心跳、投递去重、按设备路由、离线排队与补发、失败重试）。

## 0.2.0

- 接收 DSH 任务/目标通知，投递 `dsh-notify.task` 事件给 Coo；支持完成/失败、设备、会话、耗时和摘要。
- 回传策略：`off` / `window` / `keyword` / `both`；关键字支持前缀/包含/正则、大小写、去关键字。
- 回复窗口支持从通知到达或从 Coo 说完开始；每条通知可配置最多转发条数。
- 每条转发带唯一 `replyId`，DSH 用它做 `requestId` 和去重。
- 忽略 `pet_ask` 回答，只转发用户主动输入；`replyOnFailed` 可控制失败通知是否开窗。
- World 页拆成「连接设置 / 回传规则 / 高级」面板页签 + 原始「配置」页签 + 环境提示词页签。
- 新增 `dsh_notify_status` 的待回复/剩余条数/最近错误信息。
- 测试：34 个 vitest。

## 0.1.0

- 接收 DeepSeek Harness 的任务通知：`POST /notify`，Bearer 令牌鉴权。
- 通知作为 `dsh-notify.task` 事件投递给 Coo，支持完成与失败两种状态。
- 监听地址、端口、共享令牌可在 World 页配置；非回环地址强制要求令牌。
- 提供 `dsh_notify_status` 工具与 `GET /health` 健康检查。
