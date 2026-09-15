# Instead

> **Talk to my agent instead of me.**

名字就是它的用法：**不用等本人回消息，让别人直接跟你的 agent 说话** —— 而且不是某个共享的云端助手，是**你自己那条会话**：你的工作目录、transcript、工具链、凭据都在里面。

把飞书群聊接到你本地的 agent 会话上：在群里 @机器人 说话，就等于直接对某一条 agent 会话说话；会话的历史仍然留在你自己的机器上，终端和飞书只是它的两个视图。

```
飞书开放平台 ──WebSocket 长连接──> instead daemon ──本地 IPC──> agent 进程
                                        │
                                        └─ 绑定 / 路由 / 串行队列 / 持久入站出站
```

## 特性

- **免公网**：飞书长连接（WebSocket）模式，不需要公网 IP、域名或内网穿透
- **显式绑定**：一个群只能属于一条会话；没绑定过的群 @ 也不会被响应
- **一次性绑定码**：绑定凭据是会话侧签发的 6 位码（5 分钟 TTL、用后即废），**不是 session id**
- **secret 不进会话**：app secret 只经 CLI 的 TTY 静默输入，永不进入会话 transcript / argv / shell history
- **持久队列**：入站事件先落盘再分发，按 `event_id` 去重；出站按 `turn_id` 幂等重试
- **按会话串行**：一条会话同一时刻只跑一个 turn，多个群同时来消息会排队并给出回执
- **旁观消息作上下文**：群里没 @ 机器人的消息不进会话历史，只在下一次触发时作为只读上下文注入
- **`/new` 换会话**：群里发 `/new` 自动把群切到一条全新会话（旧会话原样保留在本机）
- **`/cancel` 取消**：群里发 `/cancel` 中止本群发起的 turn、撤掉本群的排队消息（上下文保留）
- **流式进度卡**：执行过程以一张卡片实时更新，结束后过程卡被替换成结果（`INSTEAD_STREAM_CARDS=0` 可关）
- **`/history [N]` 补历史**：绑定时默认只带最近 10 条群历史，要更多就发 `/history`（默认 50，可指定条数），只作用于下一条消息

## 支持的 agent

| agent | 状态 |
|---|---|
| [pi](https://pi.dev) | ✅ 已实现（`pi --mode rpc`） |
| Claude Code | ✅ 已实现（`claude -p --output-format stream-json`，一轮一进程、`--resume` 续跑）· 图片输入暂不支持（落盘后把路径交给它自己读） |
| Codex CLI | ✅ 已实现（`codex exec --json`，thread id 学回后 resume） |

三个 adapter 都有真实 CLI 的契约测试（本机 claude 15/15、codex 12/12、pi 9/9）。已知差异：只有 pi 支持运行时换模型（claude/codex 换模型要重启进程）；只有 pi 和 codex 支持图片输入；三者都无审批通道（无头下权限请求直接拒绝）。

## 状态

**M0a 已完成，真实链路已验证**：飞书群 @机器人 → daemon → pi 会话 → 回复回到群。

已完成：

- `packages/core` — 统一消息协议、绑定与一次性码、入站/出站持久队列、按会话串行队列、pendingWindow
- `packages/daemon` — 本地 IPC（Unix socket + JSONL）、会话池、idle 回收
- `packages/adapter-pi` — `pi --mode rpc` 子进程驱动
- `packages/adapter-claude` — `claude -p --output-format stream-json` 一轮一进程，`--resume` 续跑
- `packages/adapter-codex` — `codex exec --json`，thread id 学回后 resume
- `packages/channel-feishu` — 飞书 WebSocket 长连接渠道、mention 门控、4000 字分片
- `packages/cli` — `instead` 命令行

下一步（M0b）：一次性码的群侧入口、租约、多群播报、转录监听器、`/feishu-*` 会话内命令。

## 开发

需要 Node.js >= 24（用到内置 `node:sqlite` 和原生 TypeScript 类型擦除，无需构建步骤）。

```bash
npm install
npm test           # 53 tests
npm run test:unit  # 不依赖 pi 进程的部分
npm run typecheck
```

`packages/adapter-pi` 的契约测试会真的拉起一个 `pi` 进程；本机没有安装 `pi` 时自动跳过。

## 设计要点

- **会话的 transcript 是唯一记忆**，飞书和终端都只是它的视图，不存第二份
- **绑定基数**：`session 1:N chat`，`chat 1:1 session`。同一条会话绑的多个群**共享上下文**，不做隔离承诺；需要严格隔离就开两条会话
- **绑定凭据是一次性码**：session id 是标识不是凭据（它会出现在导出、截图、resume 命令行里），所以只用作引用，不用作认证
- **串行粒度是会话，不是群**：一条会话绑两个群时，按群串行会让两个群并发驱动同一个 agent
- **不依赖 agent 扩展**：统一走「spawn 进程 + 喂 prompt + 收事件」，pi 与 Claude/Codex 同构

## 快速开始

**推荐：把 [`SETUP.md`](./SETUP.md) 里的提示词复制给你的 agent**，它会带你做完 —— 你只需做 3 件必须由人做的事（建飞书应用、拉机器人进群、输一次 secret）。

手动版：

```bash
npm install
npx instead connect <app_id>   # 粘贴 app secret（TTY 静默输入）
npx instead doctor             # 体检：凭据 / 权限 / 长连接
npx instead daemon start
npx instead ui                 # 控制台：选群 / 目录 / 会话 / 模型，点绑定
```

绑定后，在群里 @机器人 即可对话。

## License

[MIT](./LICENSE)
