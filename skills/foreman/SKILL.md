---
name: foreman
description: 接单编排 CLI（项目 foreman，命令 foreman）：用 opencli 读内网 Gitea 的 ready-for-agent 工单、用 herdr 从 origin/<base> 开 worktree、用 dws 把活派给豆包会话，等会话交 RESULT 后验收、push、开 PR（可选合并关单）。当用户说自动接单、接工单、把工单派给豆包、批量跑 Gitea 工单、看某条工单处理到哪、把卡住的单放回队列，或提到 foreman 时报 app_busy / locked / pr-open 时使用。dws 只管豆包会话、opencli 只管 Gitea、herdr 只管 worktree，串联是 foreman 的事。
---

# foreman：接单编排

一个独立 CLI，源码在 `/Users/zhouteng/Documents/workspace/doubao-bot/foreman`（`doubao-bot` 工程里的子包），已 `npm link` 成全局 `foreman`。改源码立即生效。

它不实现任何下层能力，只做串联：

| 依赖 | 负责 | 谁的前提 |
| --- | --- | --- |
| `opencli gitea` | 工单/PR 读写（复用 Chrome 登录态） | Chrome 里已登录 Gitea；每条命令 20–40s |
| `herdr` | 建 git worktree（顺带在 herdr 里挂工作区） | `herdr` server 在跑（`herdr status`） |
| `dws` | 豆包会话（开会话/续说/读状态/读对话） | 豆包**单实例**，用户自己开着时要先 ⌘Q |

## 动手前

1. `foreman doctor` —— 查 dws / opencli / herdr / 各仓库的 `origin/<base>`，零副作用。
2. `foreman run --dry-run --once` —— 打印会捞哪条、worktree 建在哪、首句提示词长什么样，**不建工作区、不动会话**。
3. 真要跑再 `foreman run --once`。这一跑会长时间占着豆包窗口，先问用户能不能用。

## 命令

```bash
foreman run --dry-run --once          # 只看计划
foreman run --once                    # 跑一轮（每仓库 perRepoPerRound 条）
foreman run --every 1800              # 常驻，每 30 分钟一轮
foreman run --repo win-ai-harness --once
foreman tasks                         # 每条工单到哪一步、卡在哪
foreman retry win-ai-harness 255      # 人工处理完，放回队列（attempts 清零）
foreman doctor [--start]              # --start 才真的连豆包窗口读状态
```

`-c <文件>` 与 `--config <文件>` 等价；默认读 `./foreman.json` → `~/.foreman/config.json`。

## 一轮的流程

1. `opencli gitea search --label <id>` 拉 open 工单，按 `pickup` 过滤（排除人工标签、已处理的、到重试上限的），最老先接。
2. `herdr worktree create --cwd <repo> --branch fix/issue-N --base origin/<base> --path ~/.foreman/worktrees/<仓库>/fix-issue-N --no-focus`。
3. `dws open --name foreman-<仓库>-<N>` 发 kickoff：把工单正文、worktree、分支、边界（**只改代码 + 本地提交，不 push/不开 PR**）、`<RESULT>` 协议一次写进去。
4. 等回复跑完（`dws status` 轮询 + `dws info` 读最后一条），从里面取最后一个 `<RESULT>` 块。
5. `done` → 验收三条（工作区干净、`origin/<base>..HEAD > 0`、`verify` 命令全过）→ `git push` → `opencli gitea pr` →（`merge.enabled` 时）`pr-merge` + `close` + 清 worktree。
6. `need_decision` / `blocked` / 连续失败 → 回帖工单 + 打标签（`ready-for-human` / `agent-blocked`），**worktree 留着**。

RESULT 协议（只认最后一个块，差一点按失败处理）：

```
<RESULT>{"status":"done","branch":"fix/issue-250","tests":"mvn -q test 通过","summary":"改了 A"}</RESULT>
```

`status` 只能是 `done` / `need_decision` / `blocked` / `failed`。

## 状态与文件

- 账本 `~/.foreman/state.json`：`issues`（工单进度、分支、worktree、attempts、lastFailure）、`sessions`（会话名、convId、最后回复）
- 日志 `~/.foreman/run.log`；锁 `~/.foreman/run.lock`
- 工作区 `~/.foreman/worktrees/<仓库>/fix-issue-N`（分支名里的 `/` 换成 `-`）
- 工单状态：`planned` / `working` / `done` / `pr-open` / `needs-human` / `blocked` / `escalated` / `reset`
  `done`、`pr-open`、`needs-human`、`blocked`、`escalated` 都不会再被自动捞。

## 配置要点

- **基线统一 `sit-20261126`**（本工程所有分支都从它拉，别用 `dev`）；`repos[].base` 就是它，验收也按 `origin/<base>..HEAD` 算。
- **`pickup.labelIds` 必须是数字 id**：`opencli gitea search` 的列表结果不回 labels，按名字配会静默捞 0 条；查 id 用 `label-list`（`ready-for-agent` = 5）。配了 `labelIds` 后 foreman 不再拿名字做二次过滤。
- `merge.enabled` 默认 **false**：只开 PR 不合并，状态停在 `pr-open`——这是预期，不是卡死。
- `verify` 是逐条 `bash -lc` 跑在 worktree 里的命令；`[]` 表示只查"干净 + 有提交"。
- `herdr.enabled: false` 或 herdr 报错时退回 `git worktree add`，日志里有原因。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `{"ok":false,"error":"app_unavailable"}` / 提示 `app_busy` | 用户自己开着的豆包占了单实例 | 让用户 ⌘Q 退出豆包再跑；**不要换 profile、不要反复重试** |
| `{"ok":true,"skipped":"locked"}` | 上一轮还在跑（`~/.foreman/run.lock` 里的 pid 还活着） | 等它跑完；别在进程活着时删锁 |
| 工单一直没人接 | 看 `foreman tasks`；`needs-human`/`blocked`/`escalated`/`pr-open` 都已停 | 人处理完 `foreman retry <仓库> <N>` |
| 一条也捞不到 | `labelIds` 配的 id 不对、`excludeLabels` 命中、已指派且 `onlyUnassigned` | `foreman run --dry-run --once` 看"open N 条，可接 M 条" |
| 验收失败「工作区还有未提交改动」 | 会话没 commit 或留了临时文件 | 它会被自动回喂重试；连续失败会 `escalated` |
| 验收失败「分支上没有新提交」 | 会话只看了没改，或改在别的分支 | 同上；必要时进 worktree 手动看一眼 |
| `opencli ... 失败" | Gitea 登录态 / 权限 | 让用户在 Chrome 登录 Gitea；401 别循环重跑 |
| herdr 建不动 | server 没起 / 仓库没信任 | `herdr status`；foreman 会退回 `git worktree add` 并写日志 |

收尾：`escalated` 的单、以及被停掉的轮次留下的 worktree，用 `git -C <repo> worktree list` 确认后在仓库里
`git worktree remove --force <path>`、需要时 `git branch -D fix/issue-N`。
