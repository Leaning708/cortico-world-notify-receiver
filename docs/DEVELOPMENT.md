# 开发指南

面向接手本仓库（Coopanion World 扩展 `cortico-world-notify-receiver`）的人。先读 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [PROTOCOL.md](PROTOCOL.md)。

对端 DSH 插件 `dsh-notify-sender` 是**姐妹仓库**（原同属 `coopanion-bridge` monorepo，已分家）：协议字段的精确说明以本仓库 [PROTOCOL.md](PROTOCOL.md) 为准，两侧必须同代升级。

## 1. 环境

- Node.js **>= 22**
- pnpm **11.x**（`packageManager: pnpm@11.28.6`；用 `corepack pnpm` 最稳）
- Coopanion（Cortico）**0.2.x**，当前开发机为 0.2.16；World 契约 `cortico.api: 6`
- 联调用 DeepSeek Harness（DSH）`desktop` profile + 姐妹仓库的 `dsh-notify-sender` 插件（link 方式安装）
- Windows 开发机为当前主要环境；代码本身没有 Windows 专属逻辑，但路径/防火墙行为按 Windows 验证

## 2. 目录

```text
cortico-world-notify-receiver/
├─ README.md
├─ AGENTS.md                         # 发布检查清单（Cortico 扩展契约）
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ PROTOCOL.md
│  ├─ DEVELOPMENT.md
│  ├─ TROUBLESHOOTING.md
│  ├─ LESSONS.md
│  ├─ ROADMAP.md
│  └─ WS-DESIGN.md                   # 0.3 的选型与实施记录
├─ src/
│  ├─ definition.ts                  # WorldDefinition
│  ├─ config.ts                      # 配置类型与默认值（不再有 ConfigGroup）
│  ├─ config-save.ts                 # 面板保存的校验/夹取（纯函数）
│  ├─ world.ts                       # World 实现：事件投递、回复窗口、invoke
│  ├─ ws-server.ts                   # WS 服务端：鉴权、设备表、心跳、限流
│  ├─ tokens.ts                      # 令牌表（tokens.json，只存哈希）
│  ├─ protocol.ts                    # 帧类型与校验（纯函数）
│  ├─ reply-policy.ts                # 关键字匹配纯逻辑
│  ├─ note.ts                        # 通知解析与正文渲染
│  ├─ webui/specs.ts                 # 面板字段声明与可见性规则（纯函数）
│  ├─ webui/client.ts                # 服务/令牌/设备/回传规则 面板
│  └─ ENV_PROMPT.md
├─ dist/webui.js                     # 面板 bundle，必须提交
├─ scripts/build-webui.mjs
├─ tests/
└─ describe.json
```

## 3. 常用命令

```bash
corepack pnpm install
pnpm test            # 111 个 vitest
pnpm typecheck       # Node + WebUI 两套 tsconfig
pnpm verify:describe # describe.json 必须和代码自描述一致
pnpm build:webui     # 改 src/webui/client.ts 后必须重新构建
```

第一次 `corepack pnpm install` 在无 TTY 环境可能报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，设置 `$env:CI='true'`（PowerShell）或 `CI=true`（bash）即可。没有全局 pnpm 时可以用 DSH 自带的运行时（`<dsh-runtimes>/dependencies/pnpm/bin/pnpm.mjs`，把 node 目录加进 PATH）。

## 4. 本地安装

1. 设置 → 高级模式 → 扩展 → 从本机目录安装，选本仓库根目录。
2. 安装后「重启进程」。
3. World 总览里启用，在「服务」页设监听地址/端口，「令牌」页建一个令牌。

扩展目录是本机目录时以 **link** 方式装入：改源码后重启进程生效；`dist/webui.js` 不重新构建就不会更新面板。

端到端联调需要 DSH 里装姐妹仓库的 `dsh-notify-sender`（其 README 有安装步骤），装好后**完全退出 DSH 再打开**。

## 5. 开发任务手册

### 5.1 加一个配置项

1. `src/config.ts`：加到 `NotifyReceiverConfigSection` 接口与 `NOTIFY_RECEIVER_DEFAULTS`。
2. `src/config-save.ts`：加到保存白名单（枚举校验、数值夹取、字符串 trim 都在这里；**不加就会被当成未知键拒绝**）。
3. `src/webui/specs.ts`：加到 `SERVICE` 或 `REPLY` 的 `fields`；需要联动就加 `when: { key, in }`/`notIn`（可见性纯函数在同一文件，可直接单测）。
4. `src/world.ts`：参与行为的话在对应位置读取（`openReplyWindow` / `onTurnEnded` / `panelState()` / ws-server 回调）。
5. 测试：`tests/config-save.test.ts`（校验与夹取）、`tests/webui-visibility.test.ts`（有 `when` 时）、`tests/world.test.ts` 或 `tests/ws-server.test.ts`（行为）。
6. `pnpm typecheck && pnpm test && pnpm build:webui`（改了面板才需要 build）。

热更新规则：`host`/`port` 在 World 启动时读取（保存后返回 `restartRequired`，重启 World 生效）；心跳、设备上限、回传规则按事件现读。**令牌不在配置里**，在 `tokens.json`，改完即时生效。

### 5.2 加一个令牌/设备面板动作

1. `src/world.ts` 的 `handleInvoke` 加一个方法分支（命名 `tokens.*` / `devices.*` / `config.*`），参数从 `args[0]` 读。
2. 面板里用 `ctx.invoke('tokens.xxx', [{ ... }])` 调用（注意 HTTP 路由是 `POST /api/webui/providers/<page>/panels/<panel>/<method>`，method 段可以带点）。
3. 动作要立刻影响在线连接时，调 `this.server?.closeTokenConnections(id)` / `kick(deviceId)`。
4. 补 `tests/world.test.ts` 的 invoke 用例；`pnpm build:webui`。

### 5.3 加一个页签/面板

本扩展**不声明任何 ConfigGroup**，所以框架不会生成「配置」页签，所有配置都在自己的面板里。页签只来自 `webUi().panels`，并要求包的 `cortico.webUiClient` 指向构建产物。

1. `src/webui/client.ts` 增加 panel 实现，注册到 `bundle.panels`（可复用 `mountForm` 与 `buildForm`）。
2. `src/world.ts` 的 `webUi().panels` 增加 `{ id, title, description }`；id 必须和 bundle 的 key 一致。
3. 面板读数据用 `ctx.invoke('state')`，写配置用 `ctx.invoke('config.save', [patch])`（不要再加 ConfigGroup，加了「配置」页签就会回来）。
4. `pnpm build:webui` 生成 `dist/webui.js`，重启 Coopanion。
5. `curl http://127.0.0.1:17788/api/webui/manifest` 确认 panels 与 `client.js` URL，且 `configGroups` 不存在。

### 5.4 改协议（帧字段、关闭码、去重语义）

**必须先改本仓库 `docs/PROTOCOL.md`，再同时改两侧**（本仓库 + 姐妹仓库 `dsh-notify-sender`）：

1. `src/protocol.ts`（帧解析/编码/关闭码）+ `src/ws-server.ts`（收发）。
2. 姐妹仓库的 `lib/ws-client.js`（收发）+ `lib/notify.js` 的 `buildTaskFrame`。
3. 两侧测试同时补；`docs/WS-DESIGN.md` 记录为什么改。
4. 新增**必填**字段是破坏性变更：升版本，两侧必须同代。

**教训**：确认语义（`ack`）和幂等键（`msgId`/`replyId`）是最容易写歪的地方，改协议时优先补端到端探针。

### 5.5 改环境提示词

1. 改 `src/ENV_PROMPT.md`。
2. 改 `describe.json` 里的 prompt `content`（必须逐字一致）。
3. `pnpm verify:describe`。
4. 重启 Coopanion。

## 6. 调试

- Coopanion：World 页的「服务/设备」页签、`/health`、`dsh_notify_status` 工具、`core.log`。
- DSH：Settings 配置卡片、插件日志（连接/重连/ack/注入失败各有一行）。
- 协议：[PROTOCOL.md](PROTOCOL.md) 第 10 节的 ws 调试脚本；`/health` 看到 `onlineDevices` 说明客户端连上了。
- 端到端：先看 `onlineDevices`，再发一条带 `sessionId` 的 task，再用控制台 World 注入一条「回复 …」验证回传（`console.message` 的 `meta.body` 是正文）。
- 不要在生产 profile/真实会话上随便发测试通知；会真的让 Coo 说话。

## 7. 发布/归档检查

参考本仓库 [AGENTS.md](../AGENTS.md)：

- [ ] `cortico.api` 与当前 World 契约版本一致（当前 `6`）。
- [ ] 改过工具/事件/提示词后重新生成 `describe.json`，`pnpm verify:describe` 通过。
- [ ] `cortico.tags` 按 TAGS.md 填。
- [ ] `CHANGELOG.md` 有当前版本段落。
- [ ] `dist/webui.js` 已重新构建并提交。
- [ ] `pnpm test`、`pnpm typecheck` 通过。
- [ ] 协议有改动时，姐妹仓库 `dsh-notify-sender` 同步升版发版。
- [ ] 没有把真实令牌、绝对本机路径、日志写进包；`tokens.json` 与 profile 配置不在仓库里。
- [ ] 归档：`git tag vX.Y.Z`，`git archive` 生成 zip。

## 8. 代码约定

- 纯逻辑放 `protocol.ts` / `reply-policy.ts` / `note.ts`，`world.ts` 做状态与编排，`ws-server.ts` 只做 I/O；测试不需要起浏览器。
- 配置默认值只写一处：`NOTIFY_RECEIVER_DEFAULTS`；面板与 ws-server 都从那里读。
- 令牌只进请求头与 `tokens.json` 的哈希，不进日志、事件正文、`describe.json`、Git。
- 回调/资源释放走 `ctx.effect` / `AbortSignal`；连接、定时器都要能在 `stop()` 里收干净。
- 事件正文只陈述事实，行为指令放 `ENV_PROMPT.md`。
- DSH 侧（姐妹仓库）的约定：纯逻辑放 `lib/notify.js`，连接/队列/心跳放 `lib/ws-client.js`，`index.js` 只做事件绑定和生命周期。
