# 贡献指南

本仓库是 Coopanion（Cortico）的 World 扩展 `cortico-world-notify-receiver`：接收 DSH 任务通知、按关键字把用户回复转回 DSH。对端 DSH 插件 `dsh-notify-sender` 是姐妹仓库。

## 开始之前

1. 读 [README.md](README.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/PROTOCOL.md](docs/PROTOCOL.md)。
2. 读 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的环境和本地安装。
3. 任何协议/行为变化，先想清楚与姐妹仓库 `dsh-notify-sender` 怎么兼容，再动代码。

## 提交前检查

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm verify:describe
corepack pnpm build:webui   # 只在改了 src/webui/ 时需要，但提交前建议跑
```

- 改了 World 工具/事件/环境提示词 → 同步 `describe.json`。
- 改了 `src/webui/client.ts` → 重新构建并提交 `dist/webui.js`。
- 改了协议字段 → 同时改姐妹仓库、`docs/PROTOCOL.md` 和两侧测试。
- 不在仓库里放真实令牌、profile、日志、`node_modules`。

## 提交信息

建议用简短的祈使句，例如：

```text
fix: scan desktop-pet meta.text for replies
feat: add device registry with kick and top-up semantics
docs: archive protocol notes
```

## 发布/归档

见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 7 节和 [AGENTS.md](AGENTS.md)。每次发布：

1. `version` 递增，并与姐妹仓库保持同代；
2. 写 `CHANGELOG.md`；
3. 跑 test/typecheck/describe/build；
4. `git tag vX.Y.Z`；
5. `git archive` 生成源码 zip。

## 问题反馈

排障先看 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。新问题请附：

- Coopanion / DSH 版本；
- `/health` 结果（`world` 应为 `notify-receiver`）；
- 相关配置（**令牌打码**）；
- 是通知方向还是回传方向；
- 是否跨设备。
