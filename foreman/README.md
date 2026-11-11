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
记账 + 登记监听 → 返回 dispatched（会话随后自己改、自测、push、开 PR）
```

run 到这里就返回：**不在进程里等回复、不读 RESULT、不验收、不 push/PR、不发通知**。
会话跑完没有、结果是什么、通知谁，全由常驻服务在后台异步完成（见下一节）。
`verify` / `publish`（验收、push、开 PR）的代码还在，但当前没接线，run 不自动调用——
push 与开 PR 由会话自己在自测通过后做完，foreman 只负责派活、监听、通知。

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

- **自动握手**：除 `serve` / `help` 外，任意子命令起来先读端口文件 `~/.foreman/service.port`，
  拿端口去 ping（`GET /api/ping`）；通了直接跑，不通就自动拉起服务，等服务把端口写进文件再连
  （上限 `handshakeTimeoutMs`，默认 5s）。**全程 HTTP，没有 socket。**
- **起不来**：打印 `✗ foreman 服务没起来：<原因>`，附两条可执行提示（`foreman serve`、`cat ~/.foreman/service.log`），
  退出码 1——照做，别手动猜。
- **`--no-service`**：跳过握手与自动拉起，只跑这一条命令（测试与排障的逃生阀）。
  配置里 `service.enabled: false` 等价于一直带 `--no-service`。
- **单实例**：端口文件里的端口 ping 得通就回「已在运行」（`already-running`），退出 0；
  ping 不通但端口被别的进程占着（`port-in-use`）才报错，提示改端口。
- **停**：SIGTERM 或前台 Ctrl-C（SIGINT）→ 停轮询 → 关 HTTP → 删端口文件与 pid 文件 → 写日志退出。

### 控制台与 CLI 共用一条 HTTP

服务只有一条 HTTP 通道：CLI 的 RPC、控制台页面、控制台接口都在这一个端口上，不另起进程、没有 socket。

```json
"service": {
  "http": {
    "host": "127.0.0.1",
    "port": 7317,
    "portFile": "~/.foreman/service.port",
    "db": "~/.foreman/console.db"
  }
}
```

- 服务启动时把实际端口写成 `~/.foreman/service.port`（纯数字一行），CLI 就读这个文件。
- CLI 走 `POST /api/rpc`（body 就是原来那一帧 `{id, cmd, ...}`），探活走 `GET /api/ping`。
- 浏览器访问 `http://127.0.0.1:7317/`；`foreman status` 的 `http` / `port` / `portFile` 字段都在。
- 数据：账本（`issues` / `prWatch`）同步进 SQLite；唯一键 `"<owner>/<repo>#<number>"`，
  重复同步只更新状态与 `last_seen_at`，`first_seen_at` 保留第一次发现，**按工单去重、不重复出行**。
- 接口：`GET /api/snapshot`（当天任务 + PR）、`GET /api/polls`（最近扫描记录）、
  `POST /api/sync`（立刻扫一轮 PR 并落库）。
- `port` 允许写 `0`（系统分配端口，主要给测试）；实际端口一样写进端口文件。
- 没有 `enabled` 开关：HTTP 是唯一通道，服务起来就一定在听。要停服务用 SIGTERM / Ctrl-C。
- 页面源码在 `foreman/console/`（纯原生 HTML/CSS/JS，无依赖）。
- 页面右上角可切主题：亮 / 暗 / 自动（跟随系统）；选择存 `localStorage`，跟随系统时深浅色变化实时生效。

### 三个文件

`service.port` / `pidFile` / `logFile` 默认都在 `~/.foreman/`：

- `service.port` — 实际监听端口（纯数字一行），CLI 读它连过来
- `foreman.pid` — 单实例判活（pid、port、http、portFile、启动时间、版本）
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

## PR 监听（默认 5 分钟一轮）

服务里还有一条独立定时器，每 `prWatch.intervalSeconds`（默认 300s）扫一遍 `repos[]` 下各仓库的 open PR：

- 列表走 `opencli gitea pull-list --repo <owner/name> --state open`（新加的只读适配器命令，带回 `author`）。
- 作者在 `prWatch.ignoreAuthors`（默认 `["233151"]`，就是自己的账号）里的 PR 跳过，只记一笔 `skipped: "self"`。
- 其余 PR 合成一条消息，用 `dws notify` 发给 `prWatch.notifyTarget`：
  - `earliest`（默认）= 账本 `sessions` 里**最早登记**、有 `convId` 的那个会话，即第一个调用方；
  - 也可以直接写死会话 id 或侧边栏标题。
- 正文带 `仓库#编号`、标题、作者、PR 链接和合并命令；**只通知不合并**，合不合由收到通知的人决定。
- 去重记在 `state.json` 的 `prWatch` 键（`<repo>#<number>`），**发成功才盖 `notifiedAt`**；发送失败下一轮重试，重启不重发。
- 账本里还没有调用方会话时这轮不发、也不记账，等有调用方了下一轮补发。
- 起服务 1s 后先扫一遍，之后按间隔跑。

```bash
foreman pr poll                  # 立刻扫一轮（返回 checked / notified / target）
foreman pr list                  # 看账本里见过/已通知的 PR
foreman status                   # 带 prWatch.lastPollAt / pollCount / notifiedCount / pending
```

## 命令

```bash
foreman run --dry-run --once     # 只打印会捞哪条、建在哪、发什么；零副作用
foreman run --once               # 真跑一轮（每仓库 perRepoPerRound 条）
foreman run --every 1800         # 常驻，每 1800s 一轮
foreman run --notify <会话id|标题>  # 这一轮派出的会话，登记监听时通知目标写谁
foreman run --no-notify          # 这一轮不登记监听，因此不会有通知（连同其它参数一起用）
foreman tasks                    # 每条工单到哪一步、卡在哪
foreman pr poll                  # 立刻扫一轮 PR（别人的单报给最早登记的调用方）
foreman pr list                  # 看 PR 监听账本
foreman pr open --repo R --base sit-20261126 --head <分支> --title "…" --body "…" --issue N   # 建 PR（唯一入口，记账+落库）
foreman issue comment <N> --repo R --body "…"   # 评论工单（记账）
foreman issue close <N> --repo R                # 关单（记账）
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
    "pidFile": "~/.foreman/foreman.pid",
    "logFile": "~/.foreman/service.log",
    "handshakeTimeoutMs": 5000,
    "stopTimeoutMs": 5000,
    "http": { "host": "127.0.0.1", "port": 7317, "portFile": "~/.foreman/service.port", "db": "~/.foreman/console.db" }
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
  "prWatch": {
    "enabled": true,
    "intervalSeconds": 300,
    "state": "open",
    "maxPages": 3,
    "ignoreAuthors": ["233151"],
    "notifyTarget": "earliest"
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
- `merge.enabled` 默认 **false**：只开 PR 不合并，状态停在 `pr-open`。设为 `true` 即自动合并，
  合并由**编排自己**执行（`merge.by: foreman`，默认）：服务在会话 `done` + 带 PR + 自证非空时直接 `pr-merge` + `close`，
  每张 PR 只合一次（账本 `mergeAsk` 记 `merged`/`failed`），冲突只记录并通知、不 force merge。
- **通知默认开、且只有常驻服务这一条路**：会话跑完后，由服务用 `dws send` 把「哪条单 + 结论类别 + 分支 + PR 链接（有则带）」
  回给登记的通知目标——默认取 `notify.session`（`auto` 时取环境变量 `MCP_VM_CONVERSATION_ID`，
  也可以写成别的会话 id 或侧边栏标题）。run 自己不发通知。
- **`--notify` / `--no-notify` 只管登记**：`foreman run --notify <会话id|标题>` 把这一轮派出会话的通知目标写它；
  `--no-notify` 表示这一轮不登记监听、也就不会有通知。要永久关：`notify.enabled: false`。
- **什么时候不发**：`notify.enabled: false`；目标为空（`session: "auto"` 但当前环境没有 `MCP_VM_CONVERSATION_ID`，也没写死目标）；
  目标正好是被监听会话自己；结论不在 `notify.events` 白名单里（默认只发上面那 6 个，`working`/`planned` 不发；
  显式盯的 `session-done` 例外）。通知本身失败只写 `service.log`、计 `dwsErrors`，不打断轮询。
- **`service.enabled: false`** 等价于每条命令都带 `--no-service`：不再握手、不自动拉起服务。
  `pidFile` / `logFile` / `service.http.portFile` 都可在配置里改路径（测试用临时目录）。
- `verify` 是逐条 `bash -lc` 跑在工作区里的验收命令；空数组表示只查"干净 + 有提交"。
- `herdr.enabled: false` 时退回原生 `git worktree add`（herdr 报错时也会自动退回，并写日志）。

## 状态文件

- 账本 `~/.foreman/state.json`（`issues` 记工单进度、`sessions` 记会话与 convId、`watch` 显式登记的监听、`notified` 已通知指纹去重）
- 服务 `~/.foreman/service.port`（端口）/ `foreman.pid` / `service.log`
- 日志 `~/.foreman/run.log`
- 锁 `~/.foreman/run.lock`（一轮只许一个进程；进程死了或超 6 小时的锁会被接管）
- 工作区 `~/.foreman/worktrees/<仓库>/fix-issue-N`

工单状态：`planned` / `working` / `done` / `pr-open` / `needs-human` / `blocked` / `escalated` / `reset`。
`done`/`pr-open`/`needs-human`/`blocked`/`escalated` 都不会再被捞。

## 边界

- 会话负责"在 worktree 里改 + 自测 + `git push` + `foreman pr open` 开 PR"，边界写进首句提示词；PR / 工单的写操作只走 foreman（`pr open`、`issue comment|close`），直接 `opencli gitea` 写会让账本与控制台统计断档。
- 合并由服务在 `merge.enabled: true` 时执行（`merge.by: foreman`，默认），会话不合并；`verify` / `publish` 代码保留但没接线。
- 不做 force merge：合并失败就停下，工单留言交人。
- 豆包是单实例：用户自己开着豆包时 dws 会报 `app_busy`，整轮终止（不逐条重试），让对方 ⌘Q 后再跑。
- 用户正在用的工作区一行不动：所有改动都落在 worktree 里。

## 测试

```bash
npm test
```
