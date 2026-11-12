---
name: dws
description: 驱动 dws（豆包会话 CLI，项目 doubao-bot）：给豆包桌面端开会话、发指令、查/取会话信息、续说、打断、归档。当用户提到 dws、doubao-bot、给豆包会话派活、看某条会话跑到哪、续会话/打断会话，或遇到 dws 报 app_busy、豆包没登录、status 说不在当前窗口时使用。dws 只管豆包会话，不接工单、不碰 PR/git 远端；要自动接单请用 foreman，整条链路（选单→worktree→派活→验收→PR→通知调用方）见 workflow。
---

# dws：把豆包会话当成可脚本化执行器

`dws` 不碰豆包云端 API：它从独立 profile 拉起豆包桌面端、开 CDP 调端口，像人一样新建「工作任务」、填输入、读回复。代码在 `/Users/zhouteng/Documents/workspace/doubao-bot/dws`（`doubao-bot` 仓库里的 dws 子包），已 `npm link` 成全局命令。

**边界**：dws 只负责驱动豆包（开会话 / 发指令 / 读状态 / 存档）。工单、标签、worktree、验收、push、PR、合并、关单都已从它身上删掉了，要那些流程得在外面自己组合 dws 与别的工具。**dws 命令不需要经 foreman**——只有「建 PR」「合并 PR」这两步必须走 foreman，开会话、续说、读状态、通知都可以直接调。

## 动手前先确认这四条

1. `command -v dws`。没有链接时用 `node /Users/zhouteng/Documents/workspace/doubao-bot/dws/bin/dws.mjs <子命令>`，行为一致。
2. **豆包是单实例**：用户自己开着的豆包会占住单实例，必须让用户 **⌘Q 退出**后才能跑会话类命令。报 `app_busy` /「豆包正在用你自己的 profile 运行」时停下来说明并等用户退出，不要换 profile、不要反复重试。
3. 配置查找顺序：`./config.json` → `~/.dws/config.json`；要指定就用 `-c <文件>` 或 `--config <文件>`（两者等价）。全局配置里 `stateFile` 应写 `"state.json"`（写 `.dws/state.json` 会套成 `~/.dws/.dws/`）。
4. Node ≥ 22（用到内置 `WebSocket` / `fetch`）。

`dws doctor` 是零成本自检（豆包二进制、profile、配置）；加 `--start` 才真的拉起豆包查登录态。

## 按目标选命令

| 目标 | 命令 |
| --- | --- |
| 自检 | `dws doctor` / `dws doctor --start` |
| 看全部工作任务 + 本地会话 | `dws list` / `dws projects` |
| 看某条会话跑到哪了 | `dws status [会话名\|任务id] [--json]` |
| 取整段对话（含思考） | `dws info [会话名\|任务id] [--json] [--out <文件>]` |
| 给已有会话续话 | `dws send <会话名\|任务id> "..."` 或 `--file <文件>` |
| 新开一条会话并派活 | `dws open --name <会话名> [--repo <owner/name>] [--prompt ... \| --file ...]`；只投递不等回复加 `--no-wait` |
| 跑动中加指令 / 中断 | `dws steer <会话> "..."` / `dws stop <会话>` |
| 把窗口切到某条任务 | `dws use <任务id\|会话名>` |
| 归档一段对话 | `dws archive <任务id\|会话名>` |

```bash
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

- `use` 会把用户的豆包窗口切走；用户正在用那个窗口时不要调，改为读已落盘的 `status` / `info` 摘要。
- `status` / `info` 需要连上窗口；窗口里是别的任务时会明确报「不在当前窗口里」，并给出落盘的最后一次回复摘要——这不算失败。
- `send` 在同一任务里续说；任务已不在窗口时会新开一条并自动带 handoff（进展都在工作区提交里）。
- `stop` 是双击 Esc，没在跑会如实说；`steer` 走 Command+Enter，不打断当前任务。
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
