# 经验总结

这些是开发 Coopanion World 扩展 notify-receiver 并接入 Coopanion 桌面时实际踩过的坑。DSH 插件侧的经验见姐妹仓库 dsh-notify-sender 的 docs/DEVELOPMENT.md。后续改代码前值得先看一遍。

## 1. Coopanion 有两种聊天通道

**现象**：窗口内用户明明回复了，DSH 收不到。

**原因**：代码只扫 `console.message`，但桌宠实际发的是 `desktop-pet.message`，正文在 `meta.text`；控制台通道的正文在 `meta.body`。

**修复**：两个通道都认，优先 `meta.text` 再 `meta.body`；同时排除 `[answer]` / `meta.via === 'answer'` 的 `pet_ask` 回答。

**教训**：不要假设“用户消息”只有一种事件类型；用真实事件日志确认字段名。

## 2. 窗口过期检查不能扫之前做

**现象**：消息是在窗口内发的，但 Coo 这一轮结束得晚，窗口已经过期，消息被丢。

**原因**：在扫描前先判断 `now > expiresAt`，直接清掉了 pending。

**修复**：始终用消息时间戳 `ts <= expiresAt` 扫描；只有“窗口内没有命中”或“已经处理完”时才按当前时间关闭。

**教训**：窗口是“消息时间的边界”，不是“扫描时间的边界”。

## 3. `coo_said` 需要 `onEventsSettled`

**需求**：窗口从 Coo 说完提示开始，而不是 DSH 通知一到就开始。

**实现**：

- 收到通知时 pending 进入 `waitingForCoo`，不算截止时间；
- `onEventsSettled(events, 'delivered')` 确认通知已经投递；
- 下一轮 `onTurnEnded` 才开始计时。

**教训**：“Coo 已经收到”和“Coo 已经说完”是两个不同事件。只用 `onTurnEnded` 无法区分“这一轮是不是通知那一轮”；`onEventsSettled` 补上了这个信息。

## 4. 一条通知转多条时，`notificationId` 不能当唯一键

**现象**：`maxRepliesPerNotification: 2`，只到第一条。

**原因**：DSH 按 `notificationId` 去重，第二条被当成重复。

**修复**：每条消息生成 `replyId = notificationId:消息游标`；DSH 用 `replyId` 做 `requestId` 和去重键。

**教训**：协议里任何“同一父对象下多条子消息”的设计，都要有子消息级 id，不能复用父 id。

## 5. 关键字要匹配、去掉、跳过

**需求**：用户打「回复：把测试跑一下」，DSH 只收到「把测试跑一下」。

**实现**：

- 默认 `prefix` 匹配；
- 去掉关键字和紧跟的冒号/逗号；
- 去掉后为空则不转发；
- `pet_ask` 的回答不当作回复；
- 关键字列表用逗号/换行分隔，避免 UI 数组输入。

**教训**：如果关键字只是“检查包含”，用户会看到 DSH 收到带命令前缀的正文；转发前要清洗。

## 6. ConfigGroup 不是页签

**现象**：把配置拆成三个 ConfigGroup，页面只是三个分组，没有页签。

**原因**：Cortico 一个 World 的 `config` 只生成一个「配置」页签；页签来自 `webUi().panels`，每个 panel 需要 `cortico.webUiClient` 浏览器 bundle。

**实现**：

- `src/webui/client.ts` 注册 3 个 panel；
- `webUi().panels` 声明同 id；
- `ctx.invoke('state')` 读配置；
- `ctx.setConfig(groupId, values)` 写回 ConfigGroup；
- `pnpm build:webui` 生成 `dist/webui.js` 并提交。

**教训**：先看框架的 tab 规则，再决定用 config group 还是 panel。不要用“分组”冒充“页签”。

**0.3.1 追加**：如果连「配置」页签都不想要，就一个 ConfigGroup 都别声明——页签是按 `configGroups` 是否存在生成的（`host.ts` 的 `tabsOf()`）。代价是 `ctx.setConfig(groupId, …)` 也没了，保存要改成自己的 `ctx.invoke('config.save', [patch])` → `WorldContext.persist(patch)`（`cortico@0.2.11` 的类型里就有 `persist` / `restart`）。换来的是页签、分组、联动全部自己说了算，校验也在自己手里（`config-save.ts`）；失去的是那份原始表单兜底——对“面板已经覆盖全部字段”的扩展来说，这笔交易很划算。

## 7. pnpm store 不一致会锁死扩展安装

**现象**：扩展市场安装报 `ERR_PNPM_UNEXPECTED_STORE`。

**原因**：手动 `corepack pnpm add` 用全局 store/pnpm 12 装了扩展；Coopanion 管理器用本地 store/pnpm 11。

**修复**：在扩展目录用相同 pnpm 主版本和 `--store-dir <Coopanion data>/pnpm/store/v11 --force` 重新链接。

**教训**：不要绕过扩展管理器手动改它的 `node_modules`；必须手动时，先对齐 store 和 pnpm 版本。

## 8. PowerShell 批量写文件会带 BOM

**现象**：Vite/JSON 解析报 `Unexpected token '﻿'`。

**原因**：旧式 PowerShell 重定向/`Set-Content` 可能写 UTF-8 BOM。

**教训**：批量改 JSON/Markdown 用不会写 BOM 的工具；改完 `git diff`/解析一次。项目约定无 BOM UTF-8。

## 9. 纯逻辑和 I/O 要分开

**收益**：

- `note.ts` / `reply-policy.ts` 可以纯函数测试，不需要起 HTTP；
- `notify.js` 可以 `node --test` 直接测；
- World 测试用 `FakeHost` + 真实 HTTP receiver，覆盖鉴权、窗口、转发顺序。

**教训**：窗口/关键字/次数这种容易出边界的逻辑不要塞进 HTTP handler；先写纯函数，再接线。

## 10. 测试要覆盖“时间”和“事件顺序”

容易漏的用例：

- 消息在窗口内、但 turn 结束晚；
- 非关键字消息在前，关键字消息在后；
- `coo_said` 在通知投递前/后；
- 同一通知两条消息、第三条应留在 Coopanion；
- 失败通知不开窗；
- `pet_ask` 回答被忽略；
- `replyId` 去重。

**教训**：只测“正常路径”不够；这个桥的 bug 基本都在时序和去重上。

## 11. 文档中的协议要和代码逐字对齐

**现象**：`describe.json` 与 `ENV_PROMPT.md` 内容不一致，`verify:describe` 失败。

**教训**：改提示词/工具/事件后，立刻同步 `describe.json` 并跑 `pnpm verify:describe`；改协议字段后同步 `docs/PROTOCOL.md` 和两边测试。

## 12. 配置默认值只写一处

**现象**：面板/README/代码各写一份默认值，改一处就漂移。

**做法**：

- Coo：`NOTIFY_RECEIVER_DEFAULTS` 是唯一默认值来源；面板从 `invoke('state')` 读当前值；ConfigGroup 只声明字段。
- DSH：`DEFAULTS` / `resolveSettings` 是唯一来源；`Config` 的 schema 只声明 UI。

**教训**：默认值是行为的一部分，不是文案；不要复制。

## 13. 令牌永远不要进日志/文档/截图

**做法**：

- 配置里是明文，但不回显：DSH 的 token 是 secret 字段；Coo 面板只返回 `tokenSet`。
- 文档用 `<共享令牌>`。
- 日志不打印 Authorization。
- 仓库只提交模板配置，不提交真实 profile/config。

## 14. 先做健康检查，再猜业务

两个入口都有 `GET /health`：

- Coo：`{ok, world, listening}`
- DSH：`{ok, enabled, listening}`

排障顺序：健康检查 → 令牌 → 端点 → 判定规则 → 窗口 → 次数。不要一上来改代码。

## 15. 保持“闭环”可观察

一次成功闭环应该能在日志/状态里看到：

1. DSH 发出通知（HTTP 200/cursor）；
2. Coo 收到 `dsh-notify.task`；
3. 用户消息匹配并 POST `/reply`；
4. DSH 返回 accepted；
5. DSH 新 turn 结束，再发通知。

任何一步断掉，用 `dsh_notify_status` 和两边 `/health` 定位，而不是只看 Coo 说了什么。

## 16. 版本和归档从一开始就做

这次功能迭代跨了很多轮，最后才补 Git/版本/文档。建议以后：

- 每个可运行节点提交一次；
- 协议/行为变化写 CHANGELOG；
- 打 tag 并用 `git archive` 归档；
- README 只放“怎么用”，细节放 `docs/`，避免主文档膨胀。

## 17. 长连接比 HTTP 多出来的四件事（0.3 的代价）

改成 WebSocket 之后，功能没变，但要额外写：**鉴权时机**（握手头/首帧、5 秒超时）、**心跳**（应用层 ping + 原生 ping，治睡眠唤醒僵死）、**重连**（指数退避 + 抖动）、**幂等**（`msgId` + `ack`、`replyId` + `reply-result`）。HTTP 版本这些都不需要，但也因此丢了「发失败还能补」的能力。

**教训**：改传输方式不是换个 API，是把可靠性从「没有」补到「有」。先定幂等键，再写队列。

## 18. 令牌只存哈希，就要接受「明文只显示一次」

面板里只显示 `prefix`（`cwb_5uQQ`），用户忘了就只能轮换。这是安全的代价，要在 UI 文案里写清楚（「关掉就看不到了」），否则会被当成 bug 报上来。

## 19. 跨侧协议必须用探针验，不能只看单测

两侧单测各自 100% 通过，仍可能字段名对不上（例如 task 帧是扁平的还是嵌在 `note` 下、`pong` 要不要 `ts`）。0.3 的集成用一个独立 `ws` 探针打真实服务端，才发现真正的问题都在「拼起来」这一层。

**做法**：先跑 `hello`/`ack`/去重/坏令牌/吊销，再跑真实回传（用控制台 World 注入 `console.message` 当作用户输入，`meta.body` 是正文），最后才让真实插件连上来。

## 20. link 安装的包不会替它装依赖

DSH profile 里 `link:` 的插件、Coopanion extensions 里的本机目录扩展，都不会被宿主 `pnpm add` 时连带安装自己的 `dependencies`。漏装时表现为激活期 `ERR_MODULE_NOT_FOUND`（0.2 的 `@deepseek-ai/schemastery`、0.3 的 `ws` 都踩过）。

**教训**：这类包装好后，先在包目录自己跑一次 `pnpm install`，再重启宿主。

## 21. 结构化数据不要往 ConfigGroup 里塞

Cortico 的配置只支持标量和二元数字数组，令牌列表这种结构化数据塞不进去。World 的 `ctx.dataDir` 才是扩展自己的持久化位置：`<dataDir>/worlds/<id>/tokens.json`，再声明成可清除存储，面板用 `invoke(method, args)` 做 CRUD。顺带一个好处：令牌不进 `config.json`，备份/贴配置时不会泄漏。