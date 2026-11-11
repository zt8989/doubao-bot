---
name: workflow
description: 端到端接单工作流（opencli + herdr + dws + foreman）：把内网 Gitea 的 ready-for-agent 工单派给豆包会话，会话自测通过后自己 push 并开 PR，foreman 在跑完后把结论与 PR 回给调用方会话。当用户说「走一遍工作流」「整条链路」「接单到出 PR 怎么串」「收口通知」「几个工具怎么分工」，或问某一环卡在哪（app_busy / 会话没开起来 / 验收不过 / 卡在 pr-open）时使用。
---

# workflow：一条工单从接到收

**设计原则：一个工具一个作用。** 谁也不替谁干活，串联只在一处发生。

| 工具 | 只负责 | 明确不做 |
| --- | --- | --- |
| `opencli gitea` | 工单/PR 读写（复用 Chrome 登录态） | 不建 worktree、不开会话 |
| `herdr` | 建 git worktree | 不改代码、不碰工单 |
| `dws` | 豆包会话（开会话、发指令、读状态、归档） | 不接单、不 push、不开 PR |
| `foreman` | 串联上面三个，管状态机与验收 | 不实现任何下层能力 |

代码都在 `/Users/zhouteng/Documents/workspace/doubao-bot`（`dws/`、`foreman/`、`adapters/gitea/`），已 `npm link` 成全局命令。

## 标准一轮（六步）

1. **选单**：`opencli gitea search "" --repo <owner/name> --state open --label 5`
   标签**必须用数字 id**（`ready-for-agent`=5，`needs-triage`=3，`needs-info`=4，`ready-for-human`=6，`wontfix`=7）；按名字过滤会静默捞 0 条。
2. **建工作区**：`herdr worktree create --cwd <repo> --branch fix/issue-N --base origin/sit-20261126 --path ~/.foreman/worktrees/<仓库>/fix-issue-N --no-focus`；失败退回 `git worktree add`。
3. **派活**：`dws open --name foreman-<仓库>-N --prompt <kickoff>`。kickoff 把边界写死：只在这个 worktree 改；**自测通过后自己 `git push -u origin <分支>` + `opencli gitea pr --base sit-20261126 --head <分支>` 开 PR**，把 PR 号/链接写进 RESULT；不合并、不关单、不 force push。
   **派完立刻登记监听**：`foreman watch add <convId> --notify <调用方会话> --repo <owner/name> --number N`。
   不经 `foreman run`、直接 `dws open` 派出去的会话**不会自动被监听**——没这一步，会话跑完也没人通知你。
   并且**必须在归档之前收口**：`dws archive` 会把任务从侧边栏收起，之后 `dws status` 报「侧边栏里没有任务」，监听再也判不出来（只会在 `service.log` 里刷失败）。
4. **收结果**：只认最后一个 RESULT 块，`status` ∈ `done` / `need_decision` / `blocked` / `failed`；`done` 必带 `pr` / `prUrl` 与 `tests`。监听正常时这一步由服务通知你（正文已带 PR 链接），不必轮询。
5. **核对（不代劳）**：看 RESULT 与通知——分支已推送、PR 已开（`opencli gitea pr-view <pr> --repo <owner/name>` 可复核）、`tests` 写明自证。缺哪条就回喂重试，到 `maxAttempts` 升级给人；foreman 自己不 push、不开 PR。
6. **收口**：会话开好 PR → 服务**通知调用方**（结论 + PR 链接 + 自证）→ 人验收 → 合并 → 关单 → 清 worktree 与分支。

## 通知（异步，只有常驻服务发）

run 派完活就返回，不发通知。会话跑完后，由常驻服务轮询 `dws status` 判定，再用 `dws send` 把结论回给登记的通知目标：

```json
"notify": {
  "enabled": true,
  "session": "auto",
  "events": ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"]
}
```

- `session` 写 `auto` → 取环境变量 `MCP_VM_CONVERSATION_ID`（在豆包会话里跑 foreman 时就是那条会话）；也可以写会话 id 或侧边栏标题。
- `--notify <会话id|标题>` 只表示：这一轮派出去的会话，登记监听时通知目标写谁；`--no-notify` 表示这一轮**不登记监听**，因此不会有通知。
- 三种情况**不发**：`notify.enabled: false`、目标会话就是被监听会话自己（防自己通知自己）、没配目标也没有环境变量；结论不在 `notify.events` 白名单也不发（显式盯的 `session-done` 例外）。
- 正文含仓库、单号、结论类别、PR 链接（有则带）；发送失败只写 `service.log`、计 `dwsErrors`，不打断轮询。
- **服务没在跑时通知会丢**（异步的代价，不是 bug）：`foreman watch list` 看登记在不在 → `foreman watch poll` 立刻重放一轮（已跑完、未通知的会补发）→ `foreman status` 看 `lastPollAt` / `pollCount` / `dwsErrors`。

## PR 监听（5 分钟一轮）

服务里另有一条定时器：每 `prWatch.intervalSeconds`（默认 300s）用 `opencli gitea pull-list` 扫一遍各仓库 open PR，把**作者不是 233151**（`prWatch.ignoreAuthors`）的单用 `dws notify` 报给 `prWatch.notifyTarget`——默认 `earliest`，即账本里最早登记的调用方会话。正文带 PR 链接和合并命令，**只通知不合并**，合不合由收到通知的人决定。去重记在 `state.json` 的 `prWatch` 键，发成功才记账。

```bash
foreman pr poll   # 立刻扫一轮
foreman pr list   # 看账本
```

## 铁律

- **基线统一 `sit-20261126`**，不用 `dev`；PR 一律 `--base sit-20261126`。
- **不 force merge**：冲突就停下、工单留言、交人。
- **会话自测通过就 push 并开 PR，等验收**；foreman 不 push、不开 PR、不合并（除非用户当场说"合"）。
- 一个工单一个会话名 `foreman-<仓库>-<单号>`，同名会续会话、不会重开。
- 改仓库文件只 `git add` 自己那几个文件，别 `git add -A`（工作区常同时有别人的改动）。

## 常见卡点

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `app_busy` /「豆包正在用你自己的 profile 运行」 | 用户自己开着豆包，占了单实例 | 让用户 ⌘Q 退出，别换 profile、别重试 |
| `dws status <会话名>` 说"还没开始 0 字" | dws 可能把新会话的 convId 记成了旧会话 | 用 `dws list` 按标题找真 id，再 `dws status <id>` |
| opencli 返回 401 | Chrome 登录态过期 | 让用户在 Chrome 登 Gitea，别循环重跑 |
| 卡在 `pr-open` | `merge.enabled=false` | 正常，等人验收；要自动合就改配置 |
| worktree 已存在 / `already checked out` | 上次没清干净 | `git worktree list` 确认不是在跑的工单，再 `remove` + `branch -D` |
| `skipped: locked` | 另一轮还在跑 | 看 `~/.foreman/run.lock` 的 pid 探活；进程死了下轮自动接管 |
| 服务未启动 / 监听丢事件 | 常驻服务没跑或中途挂了，跑完的会话没人通知 | `foreman ping` 确认；不行就 `foreman serve`；`foreman watch list` 看登记在不在，`foreman watch poll` 补一轮，`foreman status` 看 `lastPollAt` / `pollCount` / `dwsErrors` |

## 状态在哪

- `~/.foreman/{state.json, run.log, worktrees/}`：工单状态机（`planned`/`working`/`done`/`pr-open`/`needs-human`/`blocked`/`escalated`/`failed`）
- `~/.dws/{state.json, archives/}`：会话簿与归档
- `~/.opencli/`：适配器挂载（gitea 是真目录 + 文件级软链回仓库）

## 边界

dws 只管会话，回头要接单/出 PR 就在 foreman 里编排；不要把工单逻辑塞回 dws。反过来，foreman 里也不要写豆包 CDP 细节——那是 dws 的事。
