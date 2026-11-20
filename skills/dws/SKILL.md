---
name: dws
description: 驱动 dws（豆包会话 CLI，项目 doubao-bot）：给豆包桌面端开会话、发指令、查/取会话信息、续说、打断、归档。当用户提到 dws、doubao-bot、给豆包会话派活、看某条会话跑到哪、续会话/打断会话，或遇到 dws 报 app_busy、豆包没登录时使用。dws 只管豆包会话，不接工单、不碰 PR/git 远端；要自动接单请用 foreman。
---

# dws：把豆包会话当成可脚本化执行器

`dws` 不碰豆包云端 API：它从独立 profile 拉起豆包桌面端、开 CDP 调端口，像人一样新建「工作任务」、填输入、读回复。代码在 `/Users/zhouteng/Documents/workspace/doubao-bot/dws`（`doubao-bot` 仓库里的 dws 子包），已 `npm link` 成全局命令。

**边界**：dws 只负责驱动豆包（开会话 / 发指令 / 读状态 / 存档）。工单、标签、worktree、验收、push、PR、合并、关单都已从它身上删掉了，要那些流程得在外面自己组合 dws 与别的工具。**dws 命令不需要经 foreman**——只有「建 PR」「合并 PR」这两步必须走 foreman，开会话、续说、读状态、通知都可以直接调。

## 动手前先确认这四条

1. `command -v dws`。没有链接时用 `node /Users/zhouteng/Documents/workspace/doubao-bot/dws/bin/dws.mjs <子命令>`，行为一致。
2. **豆包是单实例**：先跑 `dws start` 独占启动（已由 dws 起好且调试端口在答就直接复用）。
   豆包在跑但没开 CDP 调试端口时，`dws start` 会拒绝并提示 `dws start --force`；`--force` 才会
   先杀掉豆包进程（用户自己开的窗口会一起没）再独占启动。不要换 profile、不要反复重试。
   从豆包会话里发出的 `dws start --force` 会被拒绝——杀豆包等于杀掉发出命令的会话，清场要到终端里跑。
   会话类命令自己也会在需要时拉起豆包，所以 `dws start` 不是前置必需，只是「先把窗口备好」。
3. 配置查找顺序：`./config.json` → `~/.dws/config.json`；要指定就用 `-c <文件>` 或 `--config <文件>`（两者等价）。全局配置里 `stateFile` 应写 `"state.json"`（写 `.dws/state.json` 会套成 `~/.dws/.dws/`）。
4. Node ≥ 22（用到内置 `WebSocket` / `fetch`）。

`dws doctor` 是零成本自检（豆包二进制、profile、配置、进程/CDP 端口），不会拉起豆包。要拉起窗口并查登录态用 `dws start`；`dws doctor --start` 已下线（和 `dws start` 重复），调用会直接报错并指向 `dws start`。

## 按目标选命令

| 目标 | 命令 |
| --- | --- |
| 自检 | `dws doctor`（要拉起豆包查登录态用 `dws start`） |
| 独占启动豆包 | `dws start`（豆包在跑但没开 CDP 时加 `--force` 先杀掉再起） |
| 看全部工作任务 + 本地会话 | `dws list` / `dws projects` |
| 看某条会话跑到哪了 | `dws status [会话名\|任务id] [--json]` |
| 取整段对话（含思考） | `dws info [会话名\|任务id] [--json] [--out <文件>]` |
| 给已有会话续话 | `dws send <会话名\|任务id> "..."` 或 `--file <文件>` |
| 新开一条会话并派活 | `dws open --name <会话名> [--repo <owner/name>] [--prompt ... \| --file ...]`；只投递不等回复加 `--no-wait` |
| 给会话发一条消息（不等回复） | `dws msg <会话> "..." [--mode steer\|queue]` |
| 中断在跑的任务 | `dws stop <会话>` |
| 把窗口切到某条任务 | `dws use <任务id\|会话名>` |
| 归档一段对话 | `dws archive <任务id\|会话名>` |

```bash
dws start                                  # 独占启动（已在跑就复用，端口在答就直说端口）
dws start --force                          # 豆包在跑但没开 CDP：杀掉进程再独占启动（用户窗口会没）
dws open --name scratch                    # 只建工作任务，不发第一句
dws open --name review --prompt "先看一眼仓库现状"
dws open --name notice --file /tmp/notice.md --no-wait   # 投递完就返回，不等第一轮回复
dws status --json                          # 给脚本用
dws info review --out /tmp/conv.md         # 整段对话很长，先落盘再读
dws send review "接着改，先跑一下单测"
```

命令层的坑：

- 会话名可以直接写豆包侧边栏里的任务标题（`dws status 委派Gitea工单`）：先精确匹配标题、再唯一包含匹配，命中后输出里会写明实际操作的任务 id；多条重名时报错不猜，改用任务 id。
- 子命令支持 `--help` / `-h`，也可以 `dws help <命令>`：三者都只打印用法、不执行。
- `dws run` / `dws retry` / `dws tasks` 已经下线，调用会返回「未知命令」——那不是版本坏了，是能力被削掉了。

会话命令的坑：

- `start` 是独占启动：没在跑就用自己的 profile 拉起豆包并开 CDP 调试端口；已由 dws 起好且端口在答就直接复用，不重复开窗口。豆包在跑但没开 CDP（用户自己开的窗口）时**默认拒绝**并提示 `dws start --force`，不会自动杀进程；`--force` 才会先 SIGTERM→SIGKILL 杀掉豆包进程再启动。**从豆包会话里发出的 `--force` 会被拒绝**（杀豆包会把发出命令的这个窗口和回复一起杀掉），清场请在终端里跑。
- `open` 会顺带拉起豆包，所以日常不必先 `dws start`；`start` 用在「想先确认窗口/登录态再派活」的场景。所有新建入口（含 `send` 自动重开）共用 `<stateFile>.open.lock` 跨进程锁，并发调用会排队；等待后刷新账本，异常退出留下的锁由系统 `shlock` 回收。
- `use` 会把用户的豆包窗口切走；用户正在用那个窗口时不要调。`status` 只读侧边栏和本地会话 JSONL，不会切窗口。
- `status` 用侧边栏判断 `running`，用本地 `trajectory.jsonl` 读最后回复；窗口连不上时回退到本地 JSONL / 落盘摘要。`info` 取整段对话仍需要连上窗口并切到目标任务。
- `send` 在同一任务里续说；任务已不在窗口时会新开一条并自动带 handoff（进展都在工作区提交里）。
- `open` 认新会话靠**侧边栏任务差集**（`--json` 里 `locatedBy: "sidebar"`），不看窗口 URL：豆包单实例只有一个窗口，用户点回自己的任务时读到的是别人的 id。所以「回读 id 与新建前相同」这个结论已经不再作为派活失败的判据；回复没等到但侧边栏确实多出一条时，`open` 返回 `convId` + `replied: false`，别据此重派。
- 同一时刻别人（用户自己的 agent）也在建任务时，差集会有多条：`open` 会按标题/选中/在跑排序，再回读候选会话的首句认领，认到的那条带 `verified: true`；都对不上时仍返回最可能那条，但别把 `replied: false` 当失败。回复读不到是 `replyUnconfirmed: true`（宁可给空，不给别人的回复）。
- `stop` 是双击 Esc，没在跑会如实说。
- 发消息有**两个模式**：`steer` 插进当前这一轮（不排队等这一轮结束），`queue` 排到当前任务之后。键位由配置的默认模式 `messageMode` 决定——默认 `steer`：Enter = steer、Command+Enter = queue；把 `messageMode` 改成 `queue`：Enter = queue、Command+Enter = steer。只确认发出、不等回复；要等回复用 `send`。只保留 `dws msg --mode steer|queue`，旧 `dws steer` 命令已删除。`open` 与 `msg` 共用 `<stateFile>.open.lock`，新建会话和切会话投递不会并发抢窗口；`msg` 在填入正文前还会核验当前页面就是目标会话，不匹配直接报错且不发送。
- `archive` 把整段对话存到 `archives/` 并收起侧边栏任务。**目标是发出命令的会话自己时会被拒绝**（读 `MCP_VM_CONVERSATION_ID` 等环境变量判定，防止把自己归档掉），确实要动加 `--force`；`stop` 同样有这层保护。

## 写操作边界

只有「在豆包窗口里操作」这一类写：开会话、发消息、切任务、归档、中断。它不再 push 分支、不开 PR、不改工单、不关单——别指望一条 `dws` 命令跑完整个交付流程。

## 状态文件在哪

- 项目：`/Users/zhouteng/Documents/workspace/doubao-bot/dws`（`bin/dws.mjs`、`src/{cdp,doubao,sessions,config,util}.mjs`、`test/`）
- 配置：`./config.json` → `~/.dws/config.json`
- 状态：`<stateFile>`（默认 `~/.dws/state.json`，键为 `version` / `sessions` / `active`）
- 归档 `~/.dws/archives/`

## 排障

先 `dws doctor`。最容易被误判的一条：`app_busy` 是用户自己的豆包占着单实例（不是配置错）。完整现象→诊断→处理见 `references/troubleshooting.md`。
