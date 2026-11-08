# 排障

0.3.0 只有一条链路：DSH（客户端）→ Coopanion 的 `/ws`。按现象查。

> 对端 DSH 插件 `dsh-notify-sender` 是姐妹仓库（原同属 `coopanion-bridge` monorepo，已分家）。DSH 侧的排障（配置卡片、通知判定、注入失败）另见其仓库的 `docs/TROUBLESHOOTING.md`；本文以服务端（本仓库）视角覆盖整条链路。
命令里的 `<Coopanion data>` 换成实际数据目录，例如 `C:\Users\<你>\AppData\Local\Programs\Coopanion\data`。

**排障顺序**：健康检查 → 令牌 → 地址/防火墙 → 地址里的 `deviceId` → 通知判定 → 回复窗口规则。不要一上来改代码。

## 1. 先做三个检查

```powershell
# 1) 服务端在不在监听
curl.exe -sS http://127.0.0.1:3210/health
# 期望：{"ok":true,"world":"notify-receiver","protocol":"dsh-notify.ws.v1","listening":true,"onlineDevices":1}

# 2) 端口被谁占了
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3210 | Select-Object LocalAddress,LocalPort,OwningProcess

# 3) 两侧日志
#    Coopanion：World 页的灯/状态，或 <Coopanion data>\logs\core.log
#    DSH：插件日志（连接、重连、ack、注入失败都会留一行）
```

## 2. World 启动失败：非回环地址但没有令牌

现象：World 状态是 error，日志说必须设置共享令牌。

原因：监听 `0.0.0.0` / 局域网地址时，没有任何可用令牌等于把通知入口裸奔。

修复：先在本机 World 页「令牌」标签新建一个令牌，再切地址/重启 World。顺序不能反——**没有令牌时非回环地址直接拒绝启动**。

## 3. DSH 一直重连（连上又被断开）

按关闭码判断（DSH 日志里会写）：

| 关闭码 | 原因 | 处理 |
|---|---|---|
| `4401` | 令牌不对/为空 | 检查 Coo「令牌」页与 DSH `token` 是否是同一个（区分大小写、别带空格） |
| `4403` | 令牌被禁用/删除，或 `Origin` 不受信 | 重新建令牌；如果是浏览器客户端，别带外部 `Origin` |
| `4408` | 5 秒内没发 `hello` | 网络太慢或客户端版本不对 |
| `4409` | 同 `deviceId` 有更新的连接 | 两台机器 `deviceId` 撞了（默认取主机名哈希），给其中一台配 `deviceId` |
| `4429` | 在线设备超 `maxDevices` | 提高上限或断开不用的设备 |
| `1013` | 背压/限流/World 重启 | 等退避重连；频繁出现看第 7 节 |

连接正常时 DSH 日志不会刷屏；每 30 秒一次心跳是正常的。

## 4. Coo 不说话

1. `/health` 里 `devices` 是否 ≥ 1；为 0 说明 DSH 根本没连上（见第 3 节）。
2. DSH 侧 `enabled` 是否为 true、`notifyOnCompleted`/`notifyOnFailed` 是否开着。
3. `notifyMode` 是不是 `goal`——`goal` 模式对普通对话完全静默，没有建 goal 的长任务请用 `auto`/`turn`。
4. 是不是子代理会话？子代理会话固定不通知（0.3.2 起没有开关）。
5. `minTurnMs` 是否把短回合滤掉了。
6. Coo 是不是在忙（一轮还没结束）？事件会排队，等它这轮结束才说。
7. 检查 Coopanion 事件库里有没有 `dsh-notify.task`：World 页状态工具 `dsh_notify_status`，或 `/api/events`。有事件但 Coo 没说，是 Coo 的提示词/模型问题，不是桥的问题。

## 5. 回复没有转回 DSH

按顺序查：

1. `acceptReplies`（DSH）是否打开——关掉时 DSH 会回 `reply-result{ok:false}`，Coo 侧记一条 `dsh-notify.reply-failed` 事件。
2. **关键字**：0.3.3 起只有关键字匹配（默认 `回复,转给DSH`，开头匹配，大小写不敏感）。检查 `replyKeywords`、`replyKeywordMatch`、`stripKeyword`；**关键字留空 = 关闭回传**。
3. **没有窗口/条数限制**：消息命中就转，一次命中多条会全部按序转发。长时间以后打「回复 …」也可能被转走——这是预期行为，不是 bug。
4. **绑定**：待回复绑定只在「下一条通知替换 / 设备断开 / World 停止」时失效。设备断线重连会重新建绑定，旧会话不会再转。
5. **失败通知**：失败通知与完成通知一样会建绑定。
6. **设备在线**：设备离线时，已经排队的回传最多等 10 分钟（代码常量），超时写 `dsh-notify.reply-failed`。
7. **消息通道**：World 认 `console.message`（正文 `meta.body`）和 `desktop-pet.message`（正文 `meta.text`）；`pet_ask` 的 `[answer]` 也照常参与匹配（0.3.2 起不再忽略）。
8. 状态工具里能看到「待回复：设备 X / 会话 Y」与「回传：关键字 …」或「回传：关闭（未配置关键字）」。

## 6. 回传注入失败

DSH 日志会写注入失败原因，`reply-result{ok:false}` 带 error。常见：

- 会话已经不存在（DSH 重启后旧 session 被清理）；
- 会话正忙且队列拒绝（极少见）；
- `text` 超过 8000 字符（Coo 侧会先截断，正常不会触发）。

失败不会缓存 `replyId`，所以服务端可以在下一次窗口内重发；重试 3 次仍失败就记 `reply-failed`。

## 7. 设备频繁上下线 / 睡眠唤醒后失联

- 两个心跳周期（60 秒）收不到 `ping` 就会判定僵死重连；Windows 从睡眠恢复时这条最明显，属预期行为，几秒后自动恢复。
- 同一台机器切换网络（WiFi ↔ 有线）会换源 IP，连接断开后按退避重连，`deviceId` 不变，不会产生“新设备”。
- 如果每分钟都在重连：检查是不是 World 在反复重启、端口被别人占用、或 `maxDevices` 太小让两台设备互相顶号。

## 8. DSH 设置里看不到「Coopanion Bridge」

DSH **不会**为插件自动生成配置 UI，卡片来自 `lib/client.js` 的 Client 半。

1. 包里有 `dsh.client` 和 `lib/client.js`。
2. **完全退出 DSH 再打开**；只刷新页面不够，Host 只在启动时扫描 Client 半。
3. Settings → Plugins 里 bundle 是否 active。
4. 还是没有，就在 profile 的 `cordis.patch.yml` 里给这一行写 `config:`（见 DSH README）。

## 9. Coopanion 页面只有分组，没有页签

`ConfigGroup` 不是页签。一个 World 的 `config` 只生成一个「配置」页签；真正的页签来自 `webUi().panels`，并要求：

- `package.json` 的 `cortico.webUiClient` 指向已构建的 `.js`；
- bundle 的 `panels` key 与声明 id 一致；
- 改过面板后 `pnpm build:webui` 并重启 Coopanion。

**0.3.1 起本扩展故意不声明 ConfigGroup**，所以「配置」页签不会出现——这是预期行为，不是 bug。配置都在「服务 / 令牌 / 设备 / 回传规则」四个面板里，保存走面板自己的 `config.save`（内部 `ctx.persist`）。看不到某个字段时按第 5 节的可见性规则排查：它可能只是因为当前「回传判定方式」被折叠了。

排查：

```powershell
curl.exe -sS http://127.0.0.1:17788/api/webui/manifest
# 看 notify-receiver 的 panels 是否是 service/tokens/devices/reply、client.js 地址是否 200、
# 以及 configGroups 是否不存在（不存在才说明没有「配置」页签）
```

## 10. 令牌相关

- **忘记明文了**：看不回来（只存哈希）。在「令牌」页轮换或新建一个，把新的填到 DSH。
- **禁用后没断**：0.3.0 会在禁用/删除时立刻 `close(4403)` 相关连接；如果没断，确认 World 是不是还跑着旧代码（改源码后要重启进程）。
- **多人共用**：一个令牌可以被多台设备用（设备由 `deviceId` 区分）；想按设备单独吊销就一机一令牌。
- **清空**：删掉 `tokens.json` 或面板里逐个删除；清空后非回环地址会拒绝启动（符合规则）。

## 11. 从 0.2 升级到 0.3

1. **先升 Coopanion**：装新扩展 → 重启进程 → World 页会多出「服务/令牌/设备」三个页签；旧配置里的 `dshReplyEndpoint` 被忽略。
2. 在「令牌」页新建令牌（旧的单令牌配置已不再使用）。
3. **再升 DSH**：更新插件 → 完全退出 DSH 重开 → 配置里填 `wsUrl` 与新令牌；旧的 `endpoint` 为空时插件会自动推导成 `ws://…/ws`，但为稳妥请手动填。
4. 旧的 `replyEnabled`/`replyHost`/`replyPort` 会被忽略，3211 端口不再监听。
5. 0.2 的 DSH 连不上 0.3 的 World，反之亦然——两边必须一起升。

## 12. 跨设备与防火墙

- Coopanion 侧把发布地址改成 `0.0.0.0`（或本机网卡地址），Windows 第一次会弹防火墙询问，选允许。
- 确认两台设备同一网段、`ping` 得通、`curl http://<Coo 的 IP>:3210/health` 有响应。
- DSH 侧**不需要**开端口，也不需要配回发地址。
- 跨公网：不要在公网裸奔。用 Tailscale/ZeroTier 之类的隧道，或者在 Coopanion 前面放一个终结 TLS 的反代：

  ```caddyfile
  bridge.example.com {
      reverse_proxy 127.0.0.1:3210
  }
  ```

  然后 DSH 填 `wss://bridge.example.com/ws`。反代需要转发 `Upgrade`/`Connection` 头（Caddy 默认支持；Nginx 要写 `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`）。

## 13. 开发/安装类问题

### `ERR_PNPM_UNEXPECTED_STORE`（扩展市场安装失败）

`<Coopanion data>/extensions/node_modules` 被链到了全局 store，而管理器用自己的本地 store。

```powershell
cd "<Coopanion data>\extensions"
corepack pnpm@11.28.6 install --store-dir "<Coopanion data>\pnpm\store\v11" --force
```

确认 `node_modules\.modules.yaml` 里 `storeDir` 与 `packageManager` 对得上，再回扩展页重试。

### `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`

```powershell
$env:CI = 'true'; corepack pnpm install
```

### `ERR_PNPM_OUTDATED_LOCKFILE`

```bash
corepack pnpm install --no-frozen-lockfile
```

### JSON 报 `Unexpected token '﻿'`

PowerShell 的 `Out-File`/`Set-Content` 可能写 UTF-8 BOM。项目约定 JSON/Markdown 一律无 BOM UTF-8；用编辑器或 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))` 重写。

### 测试/类型检查失败

```bash
cd cortico-world-notify-receiver && pnpm typecheck && pnpm test && pnpm verify:describe
cd <dsh-notify-sender 仓库> && pnpm test
```

`verify:describe` 失败 = 改过 `ENV_PROMPT.md`/工具/事件后没同步 `describe.json`。

## 14. 怎么安全地重置

- Coopanion：改 `config.json` 的 `worlds.notify-receiver` 段前先备份；删掉这一段会回落到默认值（`enabled:false`）。令牌在 `<Coopanion data>/home/companion/data/worlds/notify-receiver/tokens.json`（实际路径以 World 的 dataDir 为准），删掉等于吊销全部。
- DSH：profile 的 `cordis.patch.yml` 里插件行配置，改前备份；删掉 `enabled` 或改成 false 即可停用。
- 不要直接删 `node_modules` 当修复手段；先看是不是 store/锁文件问题。
- 真实令牌、日志、profile 配置不要提交到 Git。
