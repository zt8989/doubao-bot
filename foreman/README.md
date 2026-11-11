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
记账 + 登记监听 → 返回 dispatched
```

run 到这里就返回：**不在进程里等回复、不读 RESULT、不验收、不 push/PR、不发通知**。
会话跑完没有、结果是什么、通知谁，全由常驻服务在后台异步完成（见下一节）。
`verify` / `publish`（验收、push、开 PR）的代码还在，但当前没接线，run 不自动调用。

worktree 建不出来时 run 当场 hold：回帖工单 + 打标签（`ready-for-human` / `agent-blocked`），返回 blocked。

会话交 `need_decision` / `blocked` 这类结论时，由服务通知到人；**worktree 留着**，
人处理完 `foreman retry <仓库> <工单号>` 放回队列。

## 常驻服务与会话监听

通知只有一条路：常驻服务在后台轮询被监听的会话，判定「这一轮跑完了」再发通知。
run 自己不发任何通知——没有同步发送的第二条路，也没有降级分支。

### 起与停

```bash
foreman serve                 # 前台跑（Ctrl-C 停）
foreman serve --daemon        # 后台跑，输出进 service.log
foreman ping                  # 在不在：pid / version / uptime / 在听几条
foreman status                # 在不在 + 监听明细 + lastPollAt / pollCount / notifiedCount / dwsErrors
```

- **自动握手**：除 `serve` / `help` 外，任意子命令起来先连 socket；通了直接跑，
  不通就自动拉起服务并等握手成功（上限 `handshakeTimeoutMs`，默认 5s）。
- **起不来**：打印 `✗ foreman 服务没起来：<原因>`，附两条可执行提示（`foreman serve`、`cat ~/.foreman/service.log`），
  退出码 1——照做，别手动猜。
- **`--no-service`**：跳过握手与自动拉起，只跑这一条命令（测试与排障的逃生阀）。
  配置里 `service.enabled: false` 等价于一直带 `--no-service`。
- **单实例**：重复启动只回「已在运行」（`already-running`），退出 0，不抢 socket；
  残留 socket（文件在但 ping 不通）会删掉重绑。
- **停**：SIGTERM 或前台 Ctrl-C（SIGINT）→ 停轮询 → 关 socket → 删 pid 文件 → 写日志退出。

### 三个文件

`socket` / `pidFile` / `logFile` 默认都在 `~/.foreman/`：

- `foreman.sock` — 本机 IPC，绑定后权限 0600（仅本人可连）
- `foreman.pid` — 单实例判活（pid、socket 路径、启动时间、版本）
- `service.log` — 服务日志，与 `run.log` 分开

三个路径都可在配置里覆盖（测试用临时目录）。账本 `state.json` 新增两个顶层键：
`watch`（显式登记的监听清单）、`notified`（已通知的指纹去重）。

### 监听与判定

```bash
foreman watch add <会话id|标题> [--notify <会话id|标题>] [--repo owner/name --number N]
foreman watch list                       # 现在在听哪些（自动登记的 + 显式盯的）
foreman watch rm <会话id|标题>            # 取消登记
foreman watch poll                       # 立刻跑一轮（checked / settled / notified），取证补漏
```

在听的会话 = 这轮 run 派出去的（自动登记）∪ `watch add` 显式盯的，按会话去重，显式优先。

服务每 `pollSeconds`（默认 20s）对每个会话跑 `dws status`：

- `streaming` 真 → running，不动；`chars: 0`（dws 的"还没开始"坑）→ pending，不动。
- `finished` 真 → finished；finished/streaming 都假但 `chars > 0` 且有 status 文本 → settled。只有这两种算跑完。
- 指纹 = `sha1(chars|head|tail)` 前 12 位。**跑完 + 指纹相对上次已通知的指纹变了**，才发一次；
  同一个 `(会话, 指纹)` 只发一次，去重记在 `state.json` 的 `notified` 键——**服务重启也不重发**。

### 通知口径

- 目标 = 登记时写的 `notifyTo`，没写取 `notify.session`（`auto` → 环境变量 `MCP_VM_CONVERSATION_ID`）。
- 正文含仓库、工单号、结论类别、PR 链接（有则带）。结论类别由服务用 `dws info` 读最后回复、
  按 RESULT 映射：`done` / `needs-human` / `blocked` / `failed`；读不到或没有工单记录 → `session-done`。
- **三种不发**：`notify.enabled: false`；目标为空（no-target）；目标正好是被监听的会话自己（self）。
  另外结论不在 `notify.events` 白名单里也不发（显式盯的 `session-done` 不做事件过滤）。
- **`--notify` 只改登记的通知目标**：`foreman run --notify <会话id|标题>` = 这一轮派出去的会话，登记监听时通知目标写谁。
  **`--no-notify` 只表示本轮不登记监听**：这一轮的会话不会被盯，也就不会有通知。
- 通知发送失败只写 `service.log`、`dwsErrors++`，不打断轮询。

### 服务没在跑时，通知会丢

异步的代价：服务没跑的时间段里跑完的会话，不会有人发通知。这不是 bug，补法：

1. `foreman watch list` —— 登记在账本里，不依赖服务活着，先看会话还在不在听。
2. `foreman watch poll` —— 立刻重放一轮，已跑完且指纹没通知过的会补发。
3. `foreman status` —— 看 `lastPollAt` / `pollCount` / `dwsErrors`，判断服务是没在跑，还是在跑但一直出错。

## 命令

```bash
foreman run --dry-run --once     # 只打印会捞哪条、建在哪、发什么；零副作用
foreman run --once               # 真跑一轮（每仓库 perRepoPerRound 条）
foreman run --every 1800         # 常驻，每 1800s 一轮
foreman run --notify <会话id|标题>  # 这一轮派出的会话，登记监听时通知目标写谁
foreman run --no-notify          # 这一轮不登记监听，因此不会有通知（连同其它参数一起用）
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
  "service": {
    "enabled": true,
    "socket": "~/.foreman/foreman.sock",
    "pidFile": "~/.foreman/foreman.pid",
    "logFile": "~/.foreman/service.log",
    "handshakeTimeoutMs": 5000,
    "stopTimeoutMs": 5000
  },
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
- **通知默认开、且只有常驻服务这一条路**：会话跑完后，由服务用 `dws send` 把「哪条单 + 结论类别 + 分支 + PR 链接（有则带）」
  回给登记的通知目标——默认取 `notify.session`（`auto` 时取环境变量 `MCP_VM_CONVERSATION_ID`，
  也可以写成别的会话 id 或侧边栏标题）。run 自己不发通知。
- **`--notify` / `--no-notify` 只管登记**：`foreman run --notify <会话id|标题>` 把这一轮派出会话的通知目标写它；
  `--no-notify` 表示这一轮不登记监听、也就不会有通知。要永久关：`notify.enabled: false`。
- **什么时候不发**：`notify.enabled: false`；目标为空（`session: "auto"` 但当前环境没有 `MCP_VM_CONVERSATION_ID`，也没写死目标）；
  目标正好是被监听会话自己；结论不在 `notify.events` 白名单里（默认只发上面那 6 个，`working`/`planned` 不发；
  显式盯的 `session-done` 例外）。通知本身失败只写 `service.log`、计 `dwsErrors`，不打断轮询。
- **`service.enabled: false`** 等价于每条命令都带 `--no-service`：不再握手、不自动拉起服务。
  `socket` / `pidFile` / `logFile` 都可在配置里改路径（测试用临时目录）。
- `verify` 是逐条 `bash -lc` 跑在工作区里的验收命令；空数组表示只查"干净 + 有提交"。
- `herdr.enabled: false` 时退回原生 `git worktree add`（herdr 报错时也会自动退回，并写日志）。

## 状态文件

- 账本 `~/.foreman/state.json`（`issues` 记工单进度、`sessions` 记会话与 convId、`watch` 显式登记的监听、`notified` 已通知指纹去重）
- 服务 `~/.foreman/foreman.sock`（IPC，0600）/ `foreman.pid` / `service.log`
- 日志 `~/.foreman/run.log`
- 锁 `~/.foreman/run.lock`（一轮只许一个进程；进程死了或超 6 小时的锁会被接管）
- 工作区 `~/.foreman/worktrees/<仓库>/fix-issue-N`

工单状态：`planned` / `working` / `done` / `pr-open` / `needs-human` / `blocked` / `escalated` / `reset`。
`done`/`pr-open`/`needs-human`/`blocked`/`escalated` 都不会再被捞。

## 边界

- 会话只负责"在 worktree 里改 + 本地提交"，边界写进首句提示词；push/PR/合并/关单不在 run 里自动做（`verify`/`publish` 代码保留但没接线）。
- 不做 force merge：合并失败就停下，工单留言交人。
- 豆包是单实例：用户自己开着豆包时 dws 会报 `app_busy`，整轮终止（不逐条重试），让对方 ⌘Q 后再跑。
- 用户正在用的工作区一行不动：所有改动都落在 worktree 里。

## 测试

```bash
npm test
```
