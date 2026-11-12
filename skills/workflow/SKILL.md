---
name: workflow
description: 端到端接单工作流：派活、建工作区、开会话、监听、通知、合并由 foreman 串起来；只有**建 PR（`foreman pr open`）与合并（`foreman pr merge`）**必须经 foreman，opencli gitea 的读与建单/改单/评论/关单、herdr、dws 会话都直连。当用户说「走一遍工作流」「整条链路」「接单到出 PR 怎么串」「收口通知」「几个工具怎么分工」，或问某一环卡在哪（app_busy / 会话没开起来 / 验收不过 / 卡在 pr-open）时使用。
---

# workflow：一条工单从接到收

**接单链路的编排归 foreman，但不是所有动作都要经它。** 只有两步收口：建 PR（`foreman pr open`）和合并（`foreman pr merge`）—— 账本要把 PR 挂到「单 + 会话」上，合并要幂等，绕过去控制台就断档。其余 Gitea 读写（读单读 PR、建单、评论、改标签、关单）、`dws` 会话、`herdr` 都能直接调，不必绕 foreman。

| 层 | 谁调 | 说明 |
| --- | --- | --- |
| `foreman` | 人 / agent / 会话 | 接单、派活、监听、通知、建 PR、合并、查进度、回炉 |
| `opencli gitea` | foreman 内部 + 人直连 | 工单/PR 读写；**只有建 PR、合并必须走 foreman**，其余读写直连 |
| `herdr` | foreman 内部 + 人直连 | 建 worktree；失败自动退回 `git worktree add` |
| `dws` | foreman 内部 + 人直连 | 豆包会话（开会话/续说/读状态/通知），不经 foreman 也行 |

代码在 `/Users/zhouteng/Documents/workspace/doubao-bot`（`foreman/`、`dws/`、`adapters/gitea/`），已 `npm link` 成全局命令。

## 标准一轮（六步）

1. **看计划**：`foreman run --dry-run --once`（可加 `--repo <名字|owner/name>`）。
   打印会捞哪条、worktree 建在哪、首句提示词长什么样；不建工作区、不动会话。
   接单顺序由配置决定：**我的（作者 `pickup.me`）→ 无人认领 → 他人**，同档最老先接。
2. **派活**：`foreman run --once`（常驻用 `foreman run --every 1800`）。
   foreman 内部依次做：选单（`opencli gitea search`，标签用数字 id）→ 建 worktree（`herdr`，失败退回 `git worktree add`）→ `dws open --name foreman-<仓库>-<N>` 发 kickoff → 账本记 `working` + `agent` → 登记监听。**派完只返回 `dispatched`，不等回复。**
   kickoff 已经把边界写死：只在这个 worktree 改；自测通过后 `git push -u origin <分支>`，再用 `foreman pr open … --issue N` 开 PR；不合并、不 force push。
3. **会话侧产出**：只在 worktree 改代码 → 本地提交 → 自测 → push → `foreman pr open --repo <仓库> --head <分支> --title "fix(#N): …" --body "<自证>" --issue N`（基线取配置 `repos[].base`，不写死）。
   PR **只能**经 foreman 建（`pr open`），它写账本、立刻落 SQLite 控制台；工单侧评论/关单/改标签可以直接 `opencli gitea`，不经 foreman 也不影响流转。最后交 RESULT：`done` 必带 `pr` / `prUrl` / `tests`。
4. **收结果**：服务在后台轮询 `dws status` + `dws info`，取最后一个 `<RESULT>` 块，把结论用 `dws send` 回给登记的调用方。
   `planner.enabled: true` 时**同一条通知**里还会带上：跑完是 `done`、在跑单 < `maxRunning`、队列里还有活 → 「可以继续接单」+ 工单列表；不是 `done` → 「需要你看一下」+ 原因与 retry 提示。
   看进度用 `foreman tasks`，看服务用 `foreman status`；**不要拿 `dws status` 手工判**（那是服务内部的事）。
5. **合并**：`merge.enabled: true` 时 **foreman 自己合并**（`pr-merge` + `close`），每张 PR 只合一次（账本 `mergeAsk`），`tests` 为空不自动合，冲突只记录不 force merge。通知正文会带「合并：已合并 PR #N」或「合并失败：…」。
   要人工决定就 `enabled: false`（默认），PR 停在 `pr-open` 等人。
6. **回炉与收尾**：卡住的单先 `foreman tasks` 看状态，再 `foreman retry <仓库名|owner/name> <N>` 放回队列（attempts 清零）；worktree 需要清理时按 `~/.foreman/worktrees/<仓库>/fix-issue-N` 手动 `git worktree remove`（这是唯一需要动 git 的收尾动作）。

## 通知（异步，只有常驻服务发）

`foreman run` 派完就返回，不发通知。会话跑完后由服务判定并发：

```json
"notify": {
  "enabled": true,
  "session": "auto",
  "events": ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"]
}
```

- `deliver.mode: "new"`（默认）：每条通知**新建一条会话**，首句 = `deliver.promptFile`（固定提示词副本）+ `监控项目：<deliver.projectDir>` + 正文；新会话 `notify: false`，不进监听。
- `deliver.mode: "existing"` 才是塞回已有会话：`session` 写 `auto` → 取 `MCP_VM_CONVERSATION_ID`；也可写会话 id 或侧边栏标题。
- 命令行：`foreman run --notify <会话id|标题>` 只改这一轮登记的通知目标（`existing` 模式）；`--no-notify` = 这一轮不登记监听，因此没有通知。
- `existing` 下三种情况**不发**：`notify.enabled: false`、目标就是被监听会话自己、没配目标也没有环境变量；结论不在 `notify.events` 白名单也不发（显式盯的 `session-done` 例外）。
- 正文含仓库、单号、结论类别、执行会话 id（编排会话靠它 `dws info` 排查/续跑）、PR 链接，以及合并结果（有则带）；没解析出 RESULT 时贴执行会话最后一条回复原文（末 1500 字）。**自动合并成功后服务会做本地收尾**：关 herdr 工作区、删 worktree、本地分支 `-d` 安全删（有未提交改动就保留并写明），通知带「清理：…」和 `<RESULT>{status:done, merged:true, pr, cleanup}</RESULT>`，通知会话随后可 `dws archive` 归档。发送失败只写 `service.log`、计 `dwsErrors`，不打断轮询。
- **服务没在跑时通知会丢**：`foreman ping` → `foreman serve` → `foreman watch list` 看登记 → `foreman watch poll` 补一轮 → `foreman status` 看 `lastPollAt` / `pollCount` / `dwsErrors`。

## PR 监听（服务里 5 分钟一轮）

服务另有定时器：每 `prWatch.intervalSeconds`（默认 300s）扫各仓库 open PR，**作者不是自己的（`pickup.me`）** 的单先过一遍冲突（有冲突的默认不报，`filterConflicts`），剩下的**交给编排 agent**：`deliver.mode: "new"`（默认）**每次新建一条会话**，首句是固定提示词（`deliver.promptFile`）+ 监控项目 + PR 列表；`deliver.mode: "existing"` 才塞回 `prWatch.notifyTarget`（默认 `earliest`，最早登记的调用方会话）。通知里带 `foreman pr merge <N> --repo R`；合并由编排 agent 核对工单后执行，合不了 foreman 回理由。命令：

```bash
foreman pr poll   # 立刻扫一轮（checked / notified / target）
foreman pr list   # 看 PR 监听账本
```

## 铁律

- **只有两步必须经 foreman**：建 PR `foreman pr open`、合并 `foreman pr merge`。其余随便：读单读 PR `opencli gitea pr-view|issue-view|search`、建单/评论/改单/关单 `opencli gitea issue|issue-comment|issue-edit|close`、`herdr`、`dws` 都直连。
- **基线与状态这类 foreman 自己的动作照旧走它**：接单 `foreman run`、看进度 `foreman tasks`、回炉 `foreman retry`、服务 `foreman ping|status|serve`。
- **基线由配置 `repos[].base` 决定**（本工程当前 `sit-20261126`），不用 `dev`；`foreman pr open` 不写 `--base` 就取它。
- **不 force merge**：冲突就停下、留记录、交人。
- **会话自测通过就 push，再用 `foreman pr open` 开 PR，不合并**；`merge.enabled: true` 时由 foreman 合并。
- **建 PR 必须走 foreman**；直接 `opencli gitea pr` 开的 PR 在账本里不存在，控制台统计断档。工单侧怎么写都不影响账本。
- 一个工单一个会话名 `foreman-<仓库>-<单号>`，同名续会话、不会重开。
- 改仓库文件只 `git add` 自己那几个文件，别 `git add -A`。

## 常见卡点

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `app_busy` /「豆包正在用你自己的 profile 运行」 | 用户自己开着豆包，占了单实例 | 让用户 ⌘Q 退出，别换 profile、别重试 |
| 一条也捞不到 | `labelIds` 不是数字 id、被排除标签命中、或已处理过 | `foreman run --dry-run --once` 看「open N 条，可接 M 条」；`foreman tasks` 看状态 |
| 卡在 `pr-open` | `merge.enabled=false` | 正常，等人验收；要自动合就改配置 |
| 会话跑完没通知 | 服务没跑、或登记被 `--no-notify` 跳过 | `foreman ping` → `foreman serve` → `foreman watch list` → `foreman watch poll` |
| 合并失败 | 分支冲突 / 无可合并 | 记录在 `mergeAsk`（`failed`），不重试；按提示人工处理或 `foreman retry` |
| `skipped: locked` | 另一轮还在跑 | `~/.foreman/run.lock` 里的 pid 探活；进程死了下轮自动接管 |
| worktree 已存在 / `already checked out` | 上次没清干净 | `git worktree list` 确认不是在跑的工单，再 `remove` + `branch -D` |
| opencli 返回 401 | Chrome 登录态过期 | 让用户在 Chrome 登 Gitea，别循环重跑 |

## 状态在哪

- `~/.foreman/state.json`：工单状态机（`planned`/`working`/`done`/`pr-open`/`needs-human`/`blocked`/`escalated`/`failed`）、`sessions`、`watch`、`notified`、`prWatch`、`mergeAsk`
- `~/.foreman/console.db`：SQLite 控制台（`tasks` 带 `agent`、`prs`、`polls`），唯一键 `<owner>/<repo>#<number>`
- `~/.foreman/{service.port, foreman.pid, service.log, run.log, worktrees/}`

## 边界

foreman 管的是**接单链路的编排**：选单、派活、监听、通知、建 PR、合并、`tasks`/`retry`。它内部才碰 opencli gitea / herdr / dws；这些下层工具反过来也不该承接编排逻辑。

但**收口只到两条**：建 PR、合并。其余都直连——读单读 PR、建单、评论、改标签、关单、`herdr` 建 worktree、`dws` 开会话续话，都不必绕 foreman，也不会让工作流停住。唯一代价是：不做收口的动作不会在 `~/.foreman/console.db` 留痕。
