# foreman

接单编排，`doubao-bot` 工程里的子包（源码就在 `doubao-bot/foreman`，`npm link` 成全局 `foreman`）。
三个工具各管一段，foreman 只做"把活儿串起来"这件事：

| 谁 | 管什么 | foreman 怎么用 |
| --- | --- | --- |
| **opencli** | Gitea 读写（复用 Chrome 登录态，无 token） | `opencli gitea search/issue-view/issue-comment/issue-edit/pr/pr-merge/close` |
| **herdr** | 创建 git worktree（同时挂到她自己的工作区视图） | `herdr worktree create --cwd <repo> --branch <分支> --base origin/<基线> --path <路径> --no-focus` |
| **dws** | 豆包会话（开会话、发指令、读状态/对话、打断） | `dws open/send/status/info/stop` |

foreman 自己不碰豆包内部实现（只走 dws 的命令行），也不手写 worktree（交给 herdr），
Gitea 侧一律走 opencli。

## 一轮做什么

```
opencli 读 ready-for-agent 工单
      ↓
herdr 从 origin/<base> 开 worktree（分支 fix/issue-N）
      ↓
dws 开会话，把工单 + 边界 + RESULT 协议一次发进去
      ↓
等会话交 <RESULT>（done / need_decision / blocked / failed）
      ↓
验收：工作区干净 + 分支有提交 + verify 命令全过
      ↓
push → opencli 开 PR →（merge.enabled 时）合并 + 关单 + 清 worktree
```

卡住的（`need_decision` / `blocked` / 连续失败）→ 回帖工单 + 打标签（`ready-for-human` / `agent-blocked`），
**worktree 留着**，人处理完 `foreman retry <仓库> <工单号>` 放回队列。

## 命令

```bash
foreman run --dry-run --once     # 只打印会捞哪条、建在哪、发什么；零副作用
foreman run --once               # 真跑一轮（每仓库 perRepoPerRound 条）
foreman run --every 1800         # 常驻，每 1800s 一轮
foreman run --notify <会话id|标题>  # 这一轮把收口通知改发到指定会话
foreman run --no-notify          # 这一轮不发通知（连同其它参数一起用）
foreman tasks                    # 每条工单到哪一步、卡在哪
foreman retry win-ai-harness 255 # 人工处理完，放回队列（attempts 清零）
foreman doctor                   # 自检：dws/opencli/herdr/仓库基线
foreman doctor --start            # 额外读一次豆包窗口状态（会连窗口，不新建任务）
```

`-c <文件>` 等价 `--config <文件>`。

## 配置

`./foreman.json` → `~/.foreman/config.json`。未知键忽略，数值写错会直接报错。

```json
{
  "stateFile": "state.json",
  "worktreeDir": "~/.foreman/worktrees",
  "pollSeconds": 20,
  "timeoutMinutes": 90,
  "maxAttempts": 3,
  "perRepoPerRound": 1,
  "dws": { "bin": "dws", "mode": "local", "model": "auto" },
  "herdr": { "bin": "herdr", "enabled": true },
  "pickup": {
    "labelIds": [5],
    "excludeLabels": ["needs-human", "ready-for-human", "needs-info", "wontfix", "agent-blocked"],
    "onlyUnassigned": true,
    "order": "oldest"
  },
  "merge": { "enabled": false, "style": "merge", "deleteBranch": true },
  "notify": {
    "enabled": true,
    "session": "auto",
    "events": ["done", "pr-open", "needs-human", "blocked", "escalated", "failed"]
  },
  "repos": [
    {
      "name": "win-ai-harness",
      "repo": "yyzl/win-ai-harness",
      "dir": "~/Documents/workspace/win-ai-harness",
      "base": "sit-20261126",
      "verify": ["mvn -q -DskipTests=false test"]
    }
  ]
}
```

要点：

- **本工程基线统一 `sit-20261126`**，不要用 `dev`：分支、worktree、验收的 `origin/<base>..HEAD` 都按它算。
- **`pickup.labelIds` 必须用数字 id，别用名字**。opencli 的列表接口不回 labels，
  按名字配会静默捞 0 条；`label-list` 能查名→id（`ready-for-agent` 当前是 5）。
- 配了 `labelIds` 后不再拿名字做二次过滤（列表里本来就没有 labels）。
- `merge.enabled` 默认 **false**：只开 PR 不合并，状态停在 `pr-open`。
- **收口通知默认开**：每条工单出结论后，foreman 用 `dws send` 把「哪条单 + 状态 + 分支 + PR 链接」回给**调用方会话**——
  即发起这轮 `foreman run` 的那条豆包会话（`session: "auto"` 时取环境变量 `MCP_VM_CONVERSATION_ID`）。
  也可以把 `session` 写成别的会话 id 或侧边栏标题。
- **怎么关**：配置里 `notify.enabled: false`，或者本轮跑 `foreman run --no-notify`；
  只想临时改回给另一条会话，用 `foreman run --notify <会话id|标题>`。
- **什么时候不发**：`--dry-run`；状态不在 `notify.events` 里（默认只发上面那 6 个，`working`/`planned` 不发）；
  `session: "auto"` 但当前环境没有 `MCP_VM_CONVERSATION_ID`（跳过并在 `run.log` 里记一行，不乱发）；
  目标会话正好是这条单自己的执行会话 `foreman-<仓库>-<单号>`（免得自己通知自己）。
  通知本身失败也只写 `run.log`，不影响这一轮的结论和退出码。
- `verify` 是逐条 `bash -lc` 跑在工作区里的验收命令；空数组表示只查"干净 + 有提交"。
- `herdr.enabled: false` 时退回原生 `git worktree add`（herdr 报错时也会自动退回，并写日志）。

## 状态文件

- 账本 `~/.foreman/state.json`（`issues` 记工单进度、`sessions` 记会话与 convId）
- 日志 `~/.foreman/run.log`
- 锁 `~/.foreman/run.lock`（一轮只许一个进程；进程死了或超 6 小时的锁会被接管）
- 工作区 `~/.foreman/worktrees/<仓库>/fix-issue-N`

工单状态：`planned` / `working` / `done` / `pr-open` / `needs-human` / `blocked` / `escalated` / `reset`。
`done`/`pr-open`/`needs-human`/`blocked`/`escalated` 都不会再被捞。

## 边界

- 会话只负责"在 worktree 里改 + 本地提交"；push/PR/合并/关单都在 foreman 这侧做，边界写进首句提示词。
- 不做 force merge：合并失败就停下，工单留言交人。
- 豆包是单实例：用户自己开着豆包时 dws 会报 `app_busy`，整轮终止（不逐条重试），让对方 ⌘Q 后再跑。
- 用户正在用的工作区一行不动：所有改动都落在 worktree 里。

## 测试

```bash
npm test
```
