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

**架构：通用 workflow = 生命周期 + 适配器**（`src/workflow/`）。流程只认生命周期事件
（捞单 → 工作区 → 派活 → 监听 → 结论 → 合并 → 清理 → 归档 → 通知），豆包 / Gitea / herdr 的差异全部收在
`src/workflow/adapters/` 里；换会话载体或工单系统时写个适配器即可。详见 `docs/workflow.md`。

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
  `GET /api/history?days=N&day=YYYY-MM-DD`（事件流水）、`POST /api/sync`（立刻扫一轮 PR 并落库）。
- 顶栏有「看哪天」日期选择（原生日历）：换一天，指标卡 / 任务表 / PR 列表全部切成那天的口径（状态从 `events` 回放，标题写 `2026-11-11 分配任务`），非今天时出现「回到今天」；`/?day=YYYY-MM-DD` 也能直接打开那天。没有单独的「历史」面板。表格里的 `仓库#号` 是链接，点开就是 Gitea 的工单/PR 页面（新标签页）。
  事件表 `events` 跟账本同库，记 `task_new` / `task_state` / `task_attempt` / `pr_new` / `pr_state` /
  `pr_open` / `pr_merge` / `issue_comment` / `issue_close`。`sync` 比对上一行状态自动记（同一状态不重复），
  `pr open|merge`、`issue comment|close` 由服务显式记；老库第一次升级会按现有单/PR 回填一批（detail 标「（回填）」）。
- `port` 允许写 `0`（系统分配端口，主要给测试）；实际端口一样写进端口文件。
- 没有 `enabled` 开关：HTTP 是唯一通道，服务起来就一定在听。要停服务用 SIGTERM / Ctrl-C。
- 前端是 **Lit 组件**（源码 `foreman/console/`：`index.html` / `app.js` / `style.css`），用 **Vite** 构建成 `console/dist`，**服务直接从本地下发，不依赖 CDN、也没有运行时 vendor 文件**。
  - 构建：`npm run build:console`（改完前端跑一次；静态文件每次请求现读，服务不用重启）。
  - 开发：`npm run dev:console`（Vite dev server，自己起在 5173，接口仍需打到服务）。
  - 还没构建时 `/` 回 **503 + 构建提示页**，不会只给一个 404。
- 页面右上角可切主题：亮 / 暗 / 自动（跟随系统）；选择存 `localStorage`，跟随系统时深浅色变化实时生效。
- 页面顶部两个页签：**「工单与 PR」（可切日期回看某天）** 和 **「定时任务」**。
  - 「定时任务」列出自动接单（`pickup.auto`）、PR 扫描（`prWatch.enabled`）、续接调度（`planner.enabled`）、工作时间窗（`workHours.offUntil` 临时闭嘴）四项，带运行状态、上次时间、下次触发与已跑轮数；
  - 自动接单与 PR 扫描的时间可自由编辑 **cron 表达式**：标准 5 段「分 时 日 月 周」，也支持第 6 段秒；对应配置 `pickup.cron` / `prWatch.cron`。没配 cron 时仍兼容旧的 `intervalSeconds`，折成分钟级表达式；
  - 点「开启/停止」或「保存时间」会 `POST /api/schedules`（如 `{"patch":{"pickup":{"enabled":true,"cron":"*/15 8-17 * * 1-5"}}}`）：先校验并改内存 cfg、再写回 `config.json`、然后立刻重排定时器，**不用重启服务**；非法 cron 返回 400，不会落盘；
  - 「立即巡检」走 `POST /api/pickup`，等价于手动 `foreman pickup`。
  - `GET /api/schedules` 返回同一份状态，脚本/CLI 也可用。
- **「操作日志」页签**：派单、投递编排通知、建/合 PR、合并后清理、执行会话归档都会先记一条「进行中」，结束再更新为「成功 / 失败」；服务重启时未收尾的记录标为「已中断」，不会永远显示正在执行。支持按状态筛选，每 15 秒自动刷新。
  - 数据在同一个 `console.db` 的 `operations` 表；查询接口 `GET /api/operations?limit=100&status=running&action=merge`（后两个参数可省略）。
  - 同时写一份到 `service.log`，前缀为 `[操作]`；日志写不进去不会阻断派单或合并主流程。

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

服务每 `pollSeconds`（默认 20s）先 `dws list --json` 读一次侧边栏（不切窗口），**还在跑的会话直接跳过**；只有没在跑的才逐个跑 `dws status`（它内部要 `goto` 切到目标会话，逐条跑会把用户窗口反复拽走）。自动巡检同理：有被监听会话还在跑，本轮就不派新会话（`window-busy`），避免豆包单实例下开会话失败或把 kickoff 发进正在跑的会话。

对被判定为「没在跑」的会话跑 `dws status`：

- `streaming` 真 → running，不动；`chars: 0`（dws 的"还没开始"坑）→ pending，不动。
- `finished` 真 → finished；finished/streaming 都假但 `chars > 0` 且有 status 文本 → settled。只有这两种算跑完。
- 指纹 = `sha1(chars|head|tail)` 前 12 位。**跑完 + 指纹相对上次已通知的指纹变了**，才发一次；
  同一个 `(会话, 指纹)` 只发一次，去重记在 `state.json` 的 `notified` 键——**服务重启也不重发**。

### 通知口径：默认每次新建会话

- `deliver.mode: "new"`（默认）：**每条通知都新建一条豆包会话**。首句 = **编排提示词**
  （运行时副本）+ `产品：<products[].name>` + `监控项目：<products[].projectDir>` + `触发：<类型>`
  + `在跑任务：N / 上限 M` + 这条通知正文，
  用 `dws open --no-wait` 投递（只确认首句送达，不等第一轮回复）。
  **这条会话是编排者，不是执行者**：任务完成、或在跑任务数低于上限时触发，由它决定
  **续跑这条已完成的工单 / 继续接下一条待办 / 自动合并已开的 PR**；
  首句明确写了「不要自己改代码实现工单」，通知正文只是决策输入，不是派给它的实现任务。
  提示词与项目目录按工单所属产品取（`products[]`）；没配 products 时用顶层 `deliver.promptFile` / `deliver.projectDir`。
  新会话记进账本 `sessions` 但 `notify: false`，**不纳入监听**——它是编排者，纳入会自己通知自己。
- `deliver.mode: "existing"`：旧行为，塞回已有会话——目标 = 登记时写的 `notifyTo`，
  没写取 `notify.session`（`auto` → 环境变量 `MCP_VM_CONVERSATION_ID`）。
- 正文含仓库、工单号、结论类别、PR 链接（有则带）。结论类别由服务用 `dws info` 读最后回复、
  按 RESULT 映射：`done` / `needs-human` / `blocked` / `failed`；读不到或没有工单记录 → `session-done`。
- **不发的情况**：`notify.enabled: false`；结论不在 `notify.events` 白名单里；
  `existing` 模式下目标为空（no-target）或目标正好是被监听的会话自己（self）。
- **`--notify` 只影响 `existing` 模式**：`foreman run --notify <会话id|标题>` = 这一轮派出去的会话，登记监听时通知目标写谁。
  **`--no-notify` 只表示本轮不登记监听**：这一轮的会话不会被盯，也就不会有通知。
- 投递失败只写 `service.log`、`dwsErrors++`，不打断轮询；同一指纹最多试 `notify.maxAttempts` 次。

### 服务没在跑时，通知会丢

异步的代价：服务没跑的时间段里跑完的会话，不会有人发通知。这不是 bug，补法：

1. `foreman watch list` —— 登记在账本里，不依赖服务活着，先看会话还在不在听。
2. `foreman watch poll` —— 立刻重放一轮，已跑完且指纹没通知过的会补发。
3. `foreman status` —— 看 `lastPollAt` / `pollCount` / `dwsErrors`，判断服务是没在跑，还是在跑但一直出错。

## 工作时间窗

两套定时器（会话监听、PR 扫描）只在 `workHours` 窗口里跑，窗口外跳过，不打扰：

```json
"workHours": { "enabled": true, "days": [1,2,3,4,5], "start": "08:30", "end": "18:30", "offUntil": "" }
```

- `days`：1=周一 … 7=周日；`start`/`end` 左闭右开（到 18:30 就停）
- `offUntil`：临时闭嘴时间点（ISO 带时区），到点自动恢复
- 不配 `workHours` 或 `enabled: false` = 全天跑；手动 `foreman pr poll` / `watch poll` 不受窗口限制
- `foreman status` 里 `workHours.active` 显示当前是否在窗口内

## PR 监听（默认 5 分钟一轮）

服务里还有一条独立定时器，每 `prWatch.intervalSeconds`（默认 300s）扫一遍 `repos[]` 下各仓库的 open PR：

- 列表走 `opencli gitea pull-list --repo <owner/name> --state open`（新加的只读适配器命令，带回 `author`）。
- 作者在 `prWatch.ignoreAuthors`（自己的账号，由 `pickup.me` 补齐）里的 PR 跳过，只记一笔 `skipped: "self"`。
- 其余 PR 合成一条消息投递出去：`deliver.mode: "new"`（默认）**新建一条会话**（首句带固定提示词 + 监控项目；
  会话名形如 `foreman-PR待合并-<YYYYMMDD-HHmm>`）；`deliver.mode: "existing"` 才用 `dws notify` 发给 `prWatch.notifyTarget`：
  - `earliest`（默认）= 账本 `sessions` 里**最早登记**、有 `convId` 的那个会话，即第一个调用方；
  - 也可以直接写死会话 id 或侧边栏标题。
- 有冲突的 PR 默认过滤（`prWatch.filterConflicts`，查 `pr-view` 的 `mergeNote`），不合也不报。
- 作者不是自己的 PR **只通知、监听里不合**（看不到关联工单）；通知带 `foreman pr merge <N> --repo R`，由编排 agent 核对工单后合并，合不了回理由。
- 去重记在 `state.json` 的 `prWatch` 键（`<repo>#<number>`），**发成功才盖 `notifiedAt`**；发送失败下一轮重试，重启不重发。
- 账本里还没有调用方会话时：`existing` 模式这轮不发、也不记账；`new` 模式不受影响（每次都新建会话）。
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
foreman pickup                   # 手动催服务跑一轮自动巡检（不用等下一个间隔）
foreman tasks                    # 每条工单到哪一步、卡在哪
foreman pr poll                  # 立刻扫一轮 PR（别人的单报给最早登记的调用方）
foreman pr list                  # 看 PR 监听账本
foreman pr open --repo R --head <分支> --title "…" --body "…" --issue N   # 建 PR（唯一入口；--base 省略取配置 repos[].base）
foreman issue comment <N> --repo R --body "…"   # 评论工单（记账）
foreman issue close <N> --repo R                # 关单（记账）
foreman retry win-ai-harness 255 # 人工处理完，放回队列（attempts 清零）
foreman doctor                   # 自检：dws/opencli/herdr/仓库基线
foreman doctor --start            # 额外读一次豆包窗口状态（会连窗口，不新建任务）
```

`-c <文件>` 等价 `--config <文件>`。

### 续接调度（planner）

`planner.enabled: true` 时，服务把续接内容**并进这条结论通知**（一次只发一条）：

- 结论 `done` + 在跑单 `< maxRunning`（默认 2）+ 队列还有可接工单 → 发「可以继续接单」，正文带工单列表（`listLimit` 条，默认 5）
- 结论不是 `done` → 发「需要你看一下」，带状态/原因/分支/PR 和 `foreman retry` 提示
- 同一 `(会话, 指纹)` 只提醒一次（账本 `planner.lastKey`）；目标 `planner.target`（默认 `auto` = 最早登记的调用方）

### 产品分组（products）

一个产品 = 一套自己的项目群（仓库列表）+ 单独的提示词 + 监控项目根目录：

```json
"products": [
  {
    "name": "win-ai-stack",
    "projectDir": "~/Documents/workspace/win-ai-stack",
    "promptFile": "~/.foreman/prompts/工作原则与工作流-提示词.md",
    "repos": [
      { "name": "win-ai-harness", "repo": "yyzl/win-ai-harness", "dir": "~/Documents/workspace/win-ai-stack/win-ai-harness", "base": "sit-20261126" },
      { "name": "yyjz-oa-cloud", "repo": "yyzl/yyjz-oa-cloud", "dir": "~/Documents/workspace/win-ai-stack/YYJZ_OA_CLOUD", "base": "sit-20261126" }
    ]
  },
  {
    "name": "<另一个产品>",
    "projectDir": "<它的项目根目录>",
    "promptFile": "<这个产品自己的提示词文件>",
    "repos": [ { "repo": "owner/name", "dir": "…", "base": "…" } ]
  }
]
```

- 配了 `products` 就以它为准：捞单、PR 扫描、投递都按产品走（内部把各产品仓库摊平成一张清单）；
- `promptFile` / `projectDir` 留空时回落顶层 `deliver` 同名配置（老配置不用改）；
- 加新产品只改配置：加一段 `products[]`，给它的提示词文件，重启服务即可，不用动代码；
- PR 一轮可能跨多个仓库：全部来自同一仓库才按产品取提示词，混合时用全局 `deliver`。

### 自动巡检（pickup.auto）

`pickup.auto: true` 时，服务自己就是调度器，不用外部 cron、也不用守着敲 `foreman run`：

- 每 `pickup.intervalSeconds`（默认 1800 = 30 分钟）跑一轮捞单，且只在 `workHours`（工作日 08:30–17:30）里跑；
- 起服务 1s 后先跑一轮，重启即开始巡检；同一工单靠账本去重（`working` 状态不会再捞），不会重复派；
- 每轮最多派 `pickup.maxPerRound` 条（默认 1，豆包单实例，一次只派一条）；
- 和 CLI 的 `foreman run` 抢同一把 `run.lock`：两边同时捞会把同一条单派两次，所以谁先拿到锁谁跑；
- 只派活、不等结果；跑完的结论仍由 `pollSeconds` 轮询后按 `deliver` 口径投递；
- `foreman status` 里有 `pickup` 段（`auto/intervalSeconds/lastAt/count/lastResult`），`foreman pickup` 可手动催一轮。

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
    "order": "oldest",
    "auto": true,
    "intervalSeconds": 1800,
    "maxPerRound": 1
  },
  "workHours": { "enabled": true, "days": [1, 2, 3, 4, 5], "start": "08:30", "end": "17:30", "offUntil": "" },
  "merge": { "enabled": false, "style": "merge", "deleteBranch": true },
  "deliver": {
    "mode": "new",
    "promptFile": "~/.foreman/prompts/工作原则与工作流-提示词.md",
    "projectDir": "~/Documents/workspace/win-ai-stack",
    "namePrefix": "foreman",
    "waitFirstReply": false
  },
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
    "ignoreAuthors": ["<你的 Gitea 用户名>"],
    "notifyTarget": "earliest"
  },
  "products": [
    {
      "name": "win-ai-stack",
      "projectDir": "~/Documents/workspace/win-ai-stack",
      "promptFile": "~/.foreman/prompts/工作原则与工作流-提示词.md",
      "repos": [
        {
          "name": "win-ai-harness",
          "repo": "yyzl/win-ai-harness",
          "dir": "~/Documents/workspace/win-ai-stack/win-ai-harness",
          "base": "sit-20261126",
          "verify": ["mvn -q -DskipTests=false test"]
        }
      ]
    }
  ]
}
```

要点：

- **基线写在 `products[].repos[].base`**（没配 products 时是顶层 `repos[].base`；本工程当前 `sit-20261126`），代码不写死；分支、worktree、验收的 `origin/<base>..HEAD` 都按它算。
- **`pickup.labelIds` 必须用数字 id，别用名字**。opencli 的列表接口不回 labels，
  按名字配会静默捞 0 条；`label-list` 能查名→id（`ready-for-agent` 当前是 5）。
- 配了 `labelIds` 后不再拿名字做二次过滤（列表里本来就没有 labels）。
- `merge.enabled` 默认 **false**：只开 PR 不合并，状态停在 `pr-open`。设为 `true` 即自动合并，
  合并由**编排自己**执行（`merge.by: foreman`，默认）：服务在会话 `done` + 带 PR + 自证非空时直接 `pr-merge` + `close`，
  每张 PR 只合一次（账本 `mergeAsk` 记 `merged`/`failed`），冲突只记录并通知、不 force merge。
- **`deliver` 管「通知往哪去」**：`mode: "new"`（默认）每次新建会话投递，`promptFile` 是固定提示词的运行时副本路径
  （`~/.foreman/prompts/` 下；路径只从配置来，代码里没有内置文案），`projectDir` 是写进首句的监控项目，
  `waitFirstReply: false` 表示只确认首句送达、不等第一轮回复。`mode: "existing"` 退回塞回已有会话。
- **通知默认开、且只有常驻服务这一条路**：会话跑完后，由服务按 `deliver.mode` 投递
  「哪条单 + 结论类别 + 分支 + PR 链接（有则带）」。run 自己不发通知。
- **`--notify` / `--no-notify` 只管登记**：`foreman run --notify <会话id|标题>` 把这一轮派出会话的通知目标写它
  （只对 `deliver.mode: existing` 有意义）；`--no-notify` 表示这一轮不登记监听、也就不会有通知。要永久关：`notify.enabled: false`。
- **什么时候不发**：`notify.enabled: false`；结论不在 `notify.events` 白名单里（默认只发上面那 6 个，
  `working`/`planned` 不发；显式盯的 `session-done` 例外）；`existing` 模式下目标为空、或目标正好是被监听会话自己。
  投递本身失败只写 `service.log`、计 `dwsErrors`，不打断轮询。
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

- 会话负责"在 worktree 里改 + 自测 + `git push` + `foreman pr open` 开 PR"，边界写进首句提示词。
- **收口只有两条：建 PR（`pr open`）与合并（`pr merge`）**——账本要把 PR 挂到「单 + 会话」，合并要幂等。工单侧的读、建单、评论、改标签、关单都直接 `opencli gitea`，`herdr`、`dws` 会话也直连；这些动作只是不留痕于 `console.db`。
- 合并由服务在 `merge.enabled: true` 时执行（`merge.by: foreman`，默认），会话不合并；`verify` / `publish` 代码保留但没接线。
- 不做 force merge：合并失败就停下，工单留言交人。
- 豆包是单实例：用户自己开着豆包时 dws 会报 `app_busy`，整轮终止（不逐条重试），让对方 ⌘Q 后再跑。
- 用户正在用的工作区一行不动：所有改动都落在 worktree 里。

## 测试

```bash
npm test
```
