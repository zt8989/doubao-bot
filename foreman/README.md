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

## 以编排会话为中心（默认）

自动巡检时，每张工单都有**自己的一条编排智能体会话**（`foreman-<仓库>-<单号>-编排`），绑定在 `issues[键].orchestrator`：

```
捞到工单 → hand：新建/复用这张单的编排会话，steer 工单进去（账本记 handed）
              ↓（编排读工单，自己决定怎么派）
         dispatch：建一工程一工作区 + 开工作会话，会话 id 绑回编排（issues[键].agentConvId / .orchestrator）
              ↓
         工作会话自己改、自测、push、开 PR；每次收工由服务把结论 steer 回编排（不再新建会话、不再 notify）
              ↓
         失败/卡住 → 编排先归因：原会话能修正才 resume <执行会话id>；需要协作就补派并在完成后 steer 回原会话
              ↓
         编排核对 → pr merge（合并即关单）→ clean：清 worktree、本地分支、工作会话与监听（幂等）
```

- **按单独立**：自动接单时 `ensureIssueOrchestrator` 按工单幂等——这张单已有 `convId` 就复用，不重复开；不同工单绝不共用。
  用户自己发起的会话不需要另起：发起方就是编排（见下）。PR 监听独立走 `deliver.mode=new`，新建「合并会话」。
- **编排会话从哪来（两种都绑同一种字段 `issues[键].orchestrator`）**：
  1. **定时任务自动接单**：`foreman hand` → foreman 新建/复用这张单自己的编排会话；
  2. **用户自主发起**：用户在某个豆包会话里调 `foreman dispatch`（或 hand/resume），
     发起方会话 id（`--orchestrator <id>`，不传则取 `MCP_VM_CONVERSATION_ID`）直接绑成这张单的编排，
     工作会话的更新都 steer 回那条发起方会话，不会再另起编排会话。
- **绑定**：`dispatch` 把工作会话写进账本（`agent` / `agentConvId` / `orchestrator`，会话记录 `kind: "worker"`、`parent: <编排 id>`）。
- **失败先归因**：原会话能修正时，`foreman resume <执行会话id>` 用 `dws steer` 把「接着跑」插进指定会话，命令不收工单号；需要其他智能体时由编排补派并登记监听，完成后再 steer 回等待结果的原会话。
  续跑计数与 `lastFailure` 都写账本。
- **收尾两步**：`pr merge` 合并关单 → `foreman clean <键>` 清残留 worktree / 分支 / 工作会话，并归档**这张单自己的编排会话**（worktree 有未提交改动就保留，不删别人正在写的东西）。
  clean 只认 `book.sessions` 里 `kind: "orchestrator"` 且带这张单 `issueKey` 的会话：全局编排和「用户发起方就是编排」的会话不归档。
  编排会话万一没被 clean 收掉（比如它没跑完、或 clean 时正是命令发起方），服务每轮巡检会把**已收口（done/cleaned）**工单的编排会话补归档一次（还在跑的不动，下一轮再收）。
- **降级**：`sessionFlow.enabled: false`（或 `foreman run --direct`）退回老的多会话模型：run 自己建工作区派活、收工只落痕、PR 监听按 `deliver.mode` 投递。

配置（默认已开，不用写也能用）：

```json
"sessionFlow": { "enabled": true, "name": "", "promptFile": "", "projectDir": "", "waitFirstReply": false },
"pickup": { "handToOrchestrator": true }
```

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
当前 notify 节点只落痕、不投递（暂时不需要向谁通知），结论照常推进工单状态与账本。
`verify` / `publish`（验收、push、开 PR）的代码还在，但当前没接线，run 不自动调用——
push 与开 PR 由会话自己在自测通过后做完，foreman 只负责派活、监听、通知。

worktree 建不出来时 run 当场 hold：回帖工单 + 打标签（`ready-for-human` / `agent-blocked`），返回 blocked。

会话交 `need_decision` / `blocked` 这类结论时，由服务通知到人；**worktree 留着**，
人处理完 `foreman retry <仓库> <工单号>` 放回队列。

## 两条通道：派单与合并彻底分开

派单（接活、开会话、续跑）与合并（合 PR、关单、清工作区）是两件独立的事，走**两条独立通道**，各排各的队、各用各的并发，互不阻塞：

| 流程 | 干什么 | 并发 | 谁在推进 |
| --- | --- | --- | --- |
| **自有工单（own）** | 接单 → 建工作区 → 派活 → 开发 → 出 PR → 合并 → 关单 → 清理 → 归档 → 通知 | **同时最多 2 条在跑**（按 workflow 实例数算） | `pickup.auto` 定时器 + `foreman run` |
| **他人 PR（review）** | 扫到 → 核对/判可合 → 解冲突 → **合并助手直接执行 `foreman pr merge`** → 关单 → 清理 → 归档 → 通知 | 不占接单名额 | 「他人 PR 扫描」定时器 + 合并助手 + `runMergeTask` |

- **合并通道已取消**：没有独立 lane、没有合并定时任务、没有独立并发槽（`src/lanes.mjs` 已删除）。
  `foreman pr merge` 当场执行合并，进程内一条串行链兜住并发，账本照样写。
- **合并助手核对后直接合并**：`foreman-合并-*` 会话收到「PR 待合并」后核对归属/基线、帮解冲突，
  可合就逐条执行通知里的 `foreman pr merge`，由 `runMergeTask` 当场合并并收尾，**不交 RESULT**。
  不可合或需要人工拍板时直接用普通文字说明原因；服务不再读取合并会话结论，也不再根据 RESULT 二次合并。
- **`pickup.maxRunning`（默认 2）** 只限制定时巡检的「自有工单流程在跑数」：`engine.active("own").length` 到顶就 `skipped: "slots-full"`；
  账本 `planned`/`working` 的单数只作兜底，服务重启时 `engine.restore(book)` 会把在跑的实例补回来。
  每轮补单数 = `min(maxRunning - 在跑数, maxPerRound)`，所以 `maxPerRound` 默认也跟着变成 2（空着两个槽就一轮补两条）。
  **agent 主动调 `foreman dispatch` 不读这个上限**，即使定时巡检已经 `slots-full` 也仍可派单。
- 派单侧仍靠 `run.lock`（含 CLI `foreman run`）；合并不在定时器里跑，所以「正在合 PR」不会挡「正在派单」。
- 会话层也分开：**派单会话**（`foreman-派单-<时间戳>`，读派单提示词，只做续跑/接单）与**合并会话**
  （`foreman-合并-<时间戳>`，读合并提示词，判断可合性 + 解冲突 + 直接执行 `foreman pr merge`）。账本 `sessions.kind` 记 `deliver:dispatch` / `deliver:merge`，
  `sessions.notice` 记触发类型。
- 派单判定完一条会话，**不再当场合并、也不再入队**：会话自己 push + 开 PR，工单置 `pr-open`，
  然后立刻返回（notify 节点只落痕，不发消息；见下面「通知口径」）。
- 合并结果不另开会话、也不回执：`foreman pr merge` 触发的合并只落账本 + 控制台
  （`mergeAsk` / `mergeTask` / `pr_merge`），关单 / 清工作区 / 归档做完即收工。
  命令本身**同步回包**（`merged` / `alreadyMerged` / `closed` / `cleanup` / `worktree` / `elapsedMs` / `summary`），
  调用方拿这一条就是最终结论，不用等任何后续消息；失败同样当场回 `merge-failed` + 理由。
- **合并要指明「工程 + worktree」**：日志、控制台 `pr_merge`、CLI 回包都写成 `工程 <仓库> · worktree <路径>`；
  worktree 取账本里这条单的实现工作区（一工程一工作区时按 PR 所在仓库对号），别人的 PR / 没有工作区时写
  「无 worktree」并留一行说明；本地清理的每条 notes 也带路径（`worktree 已删除：<路径>`）。
- `foreman status` 里能看：`pickup.maxRunning / inflight`、`lanes.dispatch.workflowActive`、`merge.queued`、
  `workflow.{workflows,stages,nodes,active,runs,recent}`。

## 常驻服务与会话监听

通知只有一条路：常驻服务在后台轮询被监听的会话，判定「这一轮跑完了」再走 notify 节点。
run 自己不发任何通知——没有同步发送的第二条路，也没有降级分支。
**notify 节点当前只落痕、不投递**：判定照做、指纹照记，但不新建会话、不 `dws notify`。

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
  「分配任务」卡片另有两个：`GET /api/candidates`（待分配队列，服务端缓存 45s，`?refresh=1` 强拉）、
  `POST /api/pick`（`{"repo":"<owner/name>","number":N}` 手动接单，只派这一条）。
- 「分配任务」卡片分两个页签：**「今日任务」/「待分配任务」**。待分配列出配置仓库里**所有 open 工单**
  （接单标签 `pickup.labelIds` 只管自动巡检，不管这里），账本里已处理（`done` / `pr-open`）、已交编排（`handed`）、
  在飞（`working` 且无失败）、试到 `maxAttempts` 上限的不列；按归属分「我的 / 无人认领 / 他人认领」；
  **按归属排序（我的 → 无人认领 → 他人认领），同档按创建时间老的在前，最多显示 10 条**，响应里 `total` 是全量条数，
  超过 10 条时页脚会写明「共 N 条待分配 · 只显示前 10 条」；
  点行尾「接单」= 建工作区 + 开执行会话，**不看 `pickup.auto` 与工作时间**，但 `run.lock`、节点暂停、账本查重照旧守着，
  不会和 CLI / 自动巡检把同一张单派两遍。页脚显示「在跑 n/上限」。
  - **决策单**：工单带着 `pickup.excludeLabels` 里的标签（`needs-info` / `needs-human` / `ready-for-human` / `wontfix` / `agent-blocked`）
    时，接单走另一套提示词（`decisionKickoff`）：让 agent 先读懂工单、自己判断该不该做——信息不够就把缺的和方案写清、
    需要人答的回工单评论，判断能做才动手，不该做就说明理由（不许自己关单/改标签）。
    这类单**不交给编排会话、不登记监听、不推 `session.dispatched`**，账本记 `decision:true`、`notify:false`，
    结论由 agent 在会话里写完整；接口返回 `decision:true`，页面顶部会提示「已接下（决策单）」。
- 顶栏有「看哪天」日期选择（原生日历）：换一天，指标卡 / 任务表全部切成那天的口径（状态从 `events` 回放，标题写 `2026-11-11 分配任务`），非今天时出现「回到今天」；`/?day=YYYY-MM-DD` 也能直接打开那天。没有单独的「历史」面板。表格里的 `仓库#号` 是链接，点开就是 Gitea 的工单/PR 页面（新标签页）。
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
- 左侧导航栏提供 **「工单」（可切日期回看某天）**、**「定时任务」** 和 **「操作日志」** 三个入口，图标加文字，可折叠成纯图标并记住折叠状态；窄屏自动只显示图标。
  - 「定时任务」列出自动接单（`pickup.auto`）、他人 PR 扫描（`prWatch.enabled`）、续接调度（`planner.enabled`）、工作时间窗（`workHours.offUntil` 临时闭嘴）四项（合并通道已取消），带运行状态、上次时间、下次触发与已跑轮数；
  - 自动接单、他人 PR 扫描的时间可自由编辑 **cron 表达式**：标准 5 段「分 时 日 月 周」，也支持第 6 段秒；对应配置 `pickup.cron` / `prWatch.cron`。没配 cron 时仍兼容旧的 `intervalSeconds`，折成分钟级表达式；
  - 点「开启/停止」或「保存时间」会 `POST /api/schedules`（如 `{"patch":{"pickup":{"enabled":true,"cron":"*/15 8-17 * * 1-5"}}}`）：先校验并改内存 cfg、再写回 `config.json`、然后立刻重排定时器，**不用重启服务**；非法 cron 返回 400，不会落盘；
  - 「立即巡检」走 `POST /api/pickup`，等价于手动 `foreman pickup`。
  - `GET /api/schedules` 返回同一份状态，脚本/CLI 也可用。
- **「操作日志」页面**：派单、投递编排通知、建/合 PR、合并后清理、执行会话归档都会先记一条「进行中」，结束再更新为「成功 / 失败」；服务重启时未收尾的记录标为「已中断」，不会永远显示正在执行。支持按状态筛选，每 15 秒自动刷新。
  - 数据在同一个 `console.db` 的 `operations` 表；查询接口 `GET /api/operations?limit=100&status=running&action=merge`（后两个参数可省略）。
  - 同时写一份到 `service.log`，前缀为 `[操作]`；日志写不进去不会阻断派单或合并主流程。

### 三个文件

`service.port` / `pidFile` / `logFile` 默认都在 `~/.foreman/`：

- `service.port` — 实际监听端口（纯数字一行），CLI 读它连过来
- `foreman.pid` — 单实例判活（pid、port、http、portFile、启动时间、版本）
- `service.log` — 服务日志，与 `run.log` 分开

三个路径都可在配置里覆盖（测试用临时目录）。账本 `state.json` 新增两个顶层键：
`watch`（显式登记的监听清单）、`notified`（已通知的指纹去重，`idle` 标记「这次收工已处理」）。

### 监听与判定

```bash
foreman watch add <会话id|标题> [--notify <会话id|标题>] [--repo owner/name --number N]
foreman watch list                       # 现在在听哪些（自动登记的 + 显式盯的）
foreman watch rm <会话id|标题>            # 取消登记
foreman watch poll                       # 立刻跑一轮（checked / settled / notified），取证补漏
```

在听的会话 = 这轮 run 派出去的（自动登记）∪ `watch add` 显式盯的，按会话去重，显式优先。

服务每 `pollSeconds`（默认 20s）先 `dws list --json` 读一次侧边栏（不切窗口），**以侧边栏的 `running` 为监听主判据**：

- `running` 真 → 只记一笔，`dws status` / `dws info` 都不碰（这两个内部都要 `goto`，一个都不读才不会把用户窗口拽走）；
- `running` 假、且这次收工已经处理过 → 直接跳过，一个字节都不读（`notified` 里记 `idle`）；
- `running` 假、还没处理过 → 收工这轮读一次 `dws status` 判结论，该通知就通知，然后落 `idle`；
- 侧边栏再把它报成 `running` 时清掉 `idle`，等下一次收工重新判一轮。

读不到侧边栏（`dws list` 失败）时，尚未消费的会话仍退化为逐条 `dws status`；一旦 RESULT 已消费就同样落 `idle`，不再每轮重读。后续由侧边栏重新出现 `running`，或 `resume` / 重派 steer 显式清掉 `idle`，再读取下一次结果。

自动巡检也先读侧边栏，但**默认不因此停派**（派单通道要并行 2 张单）：只有在配置里显式打开 `pickup.pauseWhileRunning: true`（想回到「豆包单实例一次只跑一条」的老行为）时，才有在跑会话就跳过本轮（`window-busy`）。

收工那轮对 `dws status` 的判定：

- `streaming` 真 → running，不动；`chars: 0`（dws 的"还没开始"坑）→ pending，不动。
- `finished` 真 → finished；finished/streaming 都假但 `chars > 0` 且有 status 文本 → settled。只有这两种算跑完。
- 指纹 = `sha1(chars|head|tail)` 前 12 位。**跑完 + 指纹相对上次已通知的指纹变了**，才发一次；
  同一个 `(会话, 指纹)` 只发一次，去重记在 `state.json` 的 `notified` 键——**服务重启也不重发**。

### 通知口径：notify 节点保留，暂时只落痕、不投递

- **notify 节点（`notice.delivered`）还在**：暂停 / 继续、累计执行次数、控制台状态照旧；
  但节点里**不再真的发通知**——不新建派单会话、不 `dws notify`、也不拼续接催办，
  只把指纹记进账本 `notified`、落一次节点痕（detail 写「通知已停用，未发送」）。
- **PR 待合并仍然投递**：PR 扫描走的是 `deliver.mode`（`new` 新建一条 `foreman-合并-<时间戳>` 会话），
  不经 notify 节点，所以「扫到别人的 PR 交给合并助手核对」照常工作。
- **合并结果不回执**：合完只落账本（`mergeAsk` / `mergeTask`）+ 控制台 `pr_merge`，
  关单、清工作区、归档执行会话与通知会话都在 `afterMerge` 里做完，然后收工；
  合失败同样只记账，失败原因看控制台 / `mergeAsk.error`。
- **恢复投递**：从 git 历史取回 2026-11-13 之前 `pollOnce` 里的 deliver / `dws.notify` 与续接那一段，接回本节第 1 条。
- 账本 `notified` 仍按 `(会话, 指纹)` 去重：同一结论只落一次痕，服务重启不重复处理。
- `--no-notify` 仍表示**这一轮不登记监听**：这一轮的会话不会被盯，也就不会进 notify 节点。

### 服务没在跑时，结论没人判

异步的代价：服务没跑的时间段里跑完的会话，没人轮询判定（不会发通知，也不会推进工单状态）。这不是 bug，补法：

1. `foreman watch list` —— 登记在账本里，不依赖服务活着，先看会话还在不在听。
2. `foreman watch poll` —— 立刻重放一轮，已跑完且指纹没通知过的会补发。
3. `foreman status` —— 看 `lastPollAt` / `pollCount` / `dwsErrors`，判断服务是没在跑，还是在跑但一直出错。

## 工作时间窗

两套定时器（会话监听、他人 PR 扫描）只在 `workHours` 窗口里跑，窗口外跳过，不打扰：

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
- 其余 PR 合成一条消息投递出去：`deliver.mode: "new"`（默认）**新建一条合并会话**（读合并提示词 + 监控项目；
  会话名形如 `foreman-合并-<YYYYMMDD-HHmm>`）；`deliver.mode: "existing"` 才用 `dws notify` 发给 `prWatch.notifyTarget`：
  - `earliest`（默认）= 账本 `sessions` 里**最早登记**、有 `convId` 的那个会话，即第一个调用方；
  - 也可以直接写死会话 id 或侧边栏标题。
- 有冲突的 PR 默认过滤（`prWatch.filterConflicts`，查 `pr-view` 的 `mergeNote`），不合也不报。
- 作者不是自己的 PR **只通知、监听里不合**（看不到关联工单）；通知先交给合并助手核对归属/基线、解冲突，可合就由合并助手直接执行通知里的 `foreman pr merge`，不可合或需要拍板就用普通文字说明原因，不交 RESULT。
- 去重记在 `state.json` 的 `prWatch` 键（`<repo>#<number>`），**发成功才盖 `notifiedAt`**；发送失败下一轮重试，重启不重发。
- 账本里还没有调用方会话时：`existing` 模式这轮不发、也不记账；`new` 模式不受影响（每次都新建会话）。
- 起服务 1s 后先扫一遍，之后按间隔跑。

```bash
foreman pr poll                  # 立刻扫一轮（返回 checked / notified / target）
foreman pr list                  # 看账本里见过/已通知的 PR
foreman status                   # 带 prWatch.lastPollAt / pollCount / notifiedCount / pending
```

## 邮件验收（UI PR 发信 → 回复 → 自动合并）

UI 改动的 PR 不能直接合。foreman 把 PR 链接发到测试同学邮箱，主题末尾带一个筛选 ID：

```
【foreman 验收】yyzl/yyjz-oa-frontend#128 改登录按钮 [FM-ab12cd34]
```

测试同学直接回复（**不改主题**），回「验收通过」就自动合并，回「驳回：原因」就保持 PR 打开：

- 筛选 ID 由 `repo#pr` 生成（`FM-` + 8 位哈希），回信里主题被加上 `Re:` 也认得出；不认别的工具（如 `[AM:…]`）的标记。
- 发信时机：`pr open --ui` 显式声明，或服务按 worktree `git diff origin/<base>...HEAD` 认出前端文件（`.vue/.tsx/.css/...` 与 `frontend/ web/ components/ views/ pages/` 等目录，可用 `mail.uiPatterns` 覆盖）。
- 收件人：`mail.testers`。**默认是占位符 `<tester-1@example.com>` / `<tester-2@example.com>`**：占位符不发信、也不挡合并；换成真邮箱后自动生效。
- 轮转：默认 `round-robin` 一次只发一位，按 `mail.rr` 顺序轮；等 `mail.remindMinutes`（默认 120）没回复就给另一位发催办，最多催 `mail.maxReminders`（默认 2）次。`strategy: "all"` 则两个一起发。
- 收信：服务每 `mail.pollSeconds`（默认 300s）读一次收件箱（**不受工作时间窗限制**），只处理带 `[FM-…]` 且发件人在 `mail.testers` / `mail.allowSenders` 里的邮件；同一封回复按 `message_id` 只处理一次。
- 注回会话：结论 `dws steer` 到这张单的编排会话（`issues[键].orchestrator`），拿不到就退到全局编排；邮件正文只当数据，不当指令执行。
- 合并闸门：请求状态 `waiting` 时 `pr merge` 返回 `acceptance-waiting`；`rejected` 返回 `acceptance-rejected`；没开邮件、不是 UI、没有真收件人时一律放行（沿用人工验收，不卡流程）。验收通过后 foreman 自己 `runMergeTask`，不用人再敲合并。
- 人工兜底：用户当面验收并明确回了「合并」→ `foreman pr merge <N> --repo R --approved-by <人>`；测试同学在群里说通过 → `foreman mail approve <repo>#<N> --by <人>`。

```bash
foreman mail requests                # 看每条验收请求：发给谁、状态、几封回复
foreman mail poll                     # 立刻收一轮（不等下一个 cron 点）
foreman mail request <repo>#<N> --url <PR链接>   # 补发/催办一条
foreman mail send --to a@x.com,b@y.com --subject "…" --body "…"   # 手动发一封（不进账本）
foreman mail approve <repo>#<N> --by <人> --note "当面验收通过"
foreman mail reject  <repo>#<N> --by <人> --note "按钮错位"
foreman doctor                        # 开了邮件会顺带查 agently-cli 授权与验收人
```

依赖 `agently-cli`（QQ Agent Mail）：`npm i -g @tencent-qqmail/agently-cli && agently-cli auth login`。发信带 `--confirmed`（foreman 是自动流程，不走两阶段确认）。

## 命令

```bash
foreman run --dry-run --once     # 只打印会捞哪条、交给谁；零副作用
foreman run --once               # 跑一轮：捞到单交给编排会话（hand）
foreman run --direct --once      # 这一轮自己派活（老行为，不交给编排）
foreman run --every 1800         # 常驻，每 1800s 一轮
foreman run --notify <会话id|标题>  # 这一轮派出的会话，登记监听时通知目标写谁
foreman run --no-notify          # 这一轮不登记监听，因此不会有通知（连同其它参数一起用）
foreman orch start               # 手工兼容入口：起/复用顶层全局编排（自动巡检不用它）
foreman orch show                 # 每条编排会话绑了哪些工作会话、最近 steer 了什么
foreman hand <owner/name>#N      # 把工单交给编排会话（不建工作区、不开工作会话）
foreman dispatch <owner/name>#N (--prompt <编排指令> | --file <指令文件>)
                                 # 提示词必填：编排分析、任务范围与验收随首句注入，头部带完整工单 ID 和 URL；重派随 steer 发送
foreman resume <执行会话id>   # 原会话可修正时：按会话 id steer 续跑（不新开、不传工单号）
                                 # 上面三条都支持 --orchestrator <会话id>：绑到发起方会话（不传取 MCP_VM_CONVERSATION_ID）
foreman clean <owner/name>#N     # 合并关单后清 worktree / 分支 / 工作会话（幂等）
foreman clean --all              # 清所有终端态工单的残留（worktree / 分支 / 会话）
foreman pickup                   # 手动催服务跑一轮自动巡检（不用等下一个间隔）
foreman tasks                    # 每条工单到哪一步、卡在哪
foreman pr poll                  # 立刻扫一轮 PR（别人的单报给最早登记的调用方）
foreman pr list                  # 看 PR 监听账本
foreman pr open --repo R --head <分支> --title "…" --body "…" --issue N   # 建 PR（唯一入口；--base 省略取配置 repos[].base）
                                 # 加了 --ui（或 diff 认出前端文件）就自动发验收邮件
foreman pr merge <N> --repo R --approved-by <人>   # 用户当面验收、明确回了「合并」时用这条过 UI 验收闸门
foreman mail requests            # 验收请求与回复状态
foreman mail poll                # 立刻收一轮回复
foreman mail request <repo>#<N> [--url <PR链接>]    # 补发/催办验收邮件
foreman mail send --to <邮箱> --subject "…" --body "…"   # 手动发一封
foreman mail approve|reject <repo>#<N> --by <人> [--note "…"]
foreman issue comment <N> --repo R --body "…"   # 评论工单（记账）
foreman issue close <N> --repo R                # 关单（记账）
foreman retry win-ai-harness 255 # 人工处理完，放回队列（attempts 清零）
foreman doctor                   # 自检：dws/opencli/herdr/仓库基线
foreman doctor --start            # 额外读一次豆包窗口状态（会连窗口，不新建任务）
```

`-c <文件>` 等价 `--config <文件>`。

### 续接调度（planner）

`planner.enabled: true` 时，续接内容原本并进结论通知一起发（一次一条）。
**通知停用期间这段不生效**：内容不再拼进任何消息，`planner` 这张定时表只剩空跑一轮（`pollOnce`），
`planner.mjs` 的函数与账本字段保留，恢复投递后接回即可：

- 结论 `done` + 在跑单 `< maxRunning`（默认 2）+ 队列还有可接工单 → 「可以继续接单」，正文带工单列表（`listLimit` 条，默认 5）
- 结论不是 `done` → 「需要你看一下」，带状态/原因/分支/PR 和 `foreman retry` 提示
- 同一 `(会话, 指纹)` 只提醒一次（账本 `planner.lastKey`）；目标 `planner.target`（默认 `auto` = 最早登记的调用方）

### 产品分组（products）

一个产品 = 一套自己的项目群（仓库列表）+ 监控项目根目录；提示词默认用代码内置的两份（`src/builtin/dispatch-prompt.md` / `merge-prompt.md`），只有想给这个产品单独换一份时才写 `promptFile` / `mergePromptFile`：

```json
"products": [
  {
    "name": "win-ai-stack",
    "projectDir": "~/Documents/workspace/win-ai-stack",
    "repos": [
      { "name": "win-ai-harness", "repo": "yyzl/win-ai-harness", "dir": "~/Documents/workspace/win-ai-stack/win-ai-harness", "base": "sit-20261126" },
      { "name": "yyjz-oa-cloud", "repo": "yyzl/yyjz-oa-cloud", "dir": "~/Documents/workspace/win-ai-stack/YYJZ_OA_CLOUD", "base": "sit-20261126" }
    ]
  },
  {
    "name": "<另一个产品>",
    "projectDir": "<它的项目根目录>",
    "promptFile": "<可选：这个产品自己的派单提示词，留空用内置>",
    "mergePromptFile": "<可选：这个产品自己的合并提示词，留空用内置>",
    "repos": [ { "repo": "owner/name", "dir": "…", "base": "…" } ]
  }
]
```

- 配了 `products` 就以它为准：捞单、PR 扫描、投递都按产品走（内部把各产品仓库摊平成一张清单）；
- `promptFile` / `mergePromptFile` / `projectDir` 留空时回落顶层 `deliver` 同名配置（老配置不用改；`mergePromptFile` 再回落到 `promptFile`）；这些路径全空就用代码内置的两份提示词，所以新配置可以完全不写提示词；
- 加新产品只改配置：加一段 `products[]`（提示词不写就用内置），重启服务即可，不用动代码；
- PR 一轮可能跨多个仓库：全部来自同一仓库才按产品取提示词，混合时用全局 `deliver`。

### 自动巡检（pickup.auto）

`pickup.auto: true` 时，服务自己就是调度器，不用外部 cron、也不用守着敲 `foreman run`：

- 每 `pickup.intervalSeconds`（默认 1800 = 30 分钟）跑一轮捞单，且只在 `workHours`（工作日 08:30–17:30）里跑；
- **一张单收口就立刻补下一张，不等 cron**（`pickup.kickAfterDone`，默认开）：合并关单、手动完成、`foreman clean` 收尾
  三处都会在 3s 后自动补跑一轮同样的 `pickupOnce`——容量、工作时间窗、`run.lock`、节点暂停、`maxPerRound` 全部照旧把关，
  所以只是把「等下一个 cron 点」换成「槽位一空就接着派」；同一时刻只排一轮（合并后编排再调 clean 不会排第二次），
  巡检正忙（`busy`）或抢不到 `run.lock` 时 5s 后重试，最多 3 次，槽位满 / 下班只记一行日志不重试；
  写 `pickup.kickAfterDone: false` 就退回「只在 cron 点巡检」；
- 起服务 1s 后先跑一轮，重启即开始巡检；同一工单靠账本去重（`working` 状态不会再捞），不会重复派；
- **同时 2 张单在跑**（`pickup.maxRunning`，默认 2）：在跑 = 账本 `planned`/`working` 且没 `lastFailure`；
  到顶回 `skipped: "slots-full"`，有空槽才补，每轮最多补 `maxPerRound`（默认 2）条——派活动作本身仍是一条一条来；
- `pickup.pauseWhileRunning`（默认 `false`）：打开后只要侧边栏里有被监听会话在跑，本轮就不开新会话（旧行为，回落到豆包单实例一次一条）；
- 和 CLI 的 `foreman run` 抢同一把 `run.lock`：两边同时捞会把同一条单派两次，所以谁先拿到锁谁跑；
- 只派活、不等结果；跑完的结论仍由 `pollSeconds` 轮询后按 `deliver` 口径投递；
- `foreman status` 里有 `pickup` 段（`auto/intervalSeconds/maxRunning/inflight/lastAt/count/lastResult`），`foreman pickup` 可手动催一轮。

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
    "maxRunning": 2,
    "maxPerRound": 2,
    "pauseWhileRunning": false
  },
  "workHours": { "enabled": true, "days": [1, 2, 3, 4, 5], "start": "08:30", "end": "17:30", "offUntil": "" },
  "merge": { "enabled": false, "style": "merge", "deleteBranch": true, "concurrency": 1, "intervalSeconds": 60 },
  "deliver": {
    "mode": "new",
    "promptFile": "",
    "mergePromptFile": "",
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
  "mail": {
    "enabled": true,
    "bin": "agently-cli",
    "testers": ["<tester-1@example.com>", "<tester-2@example.com>"],
    "strategy": "round-robin",
    "subjectPrefix": "【foreman 验收】",
    "scanLimit": 30,
    "pollSeconds": 300,
    "remindMinutes": 120,
    "maxReminders": 2,
    "uiGate": true,
    "uiPatterns": [],
    "allowSenders": [],
    "confirmed": true
  },
  "products": [
    {
      "name": "win-ai-stack",
      "projectDir": "~/Documents/workspace/win-ai-stack",
      "promptFile": "~/.foreman/prompts/派单提示词.md",
      "mergePromptFile": "~/.foreman/prompts/合并提示词.md",
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
- **合并通道已取消**：会话 `done` 只把 PR 记进账本，合不合由编排会话核对工单后
  `foreman pr merge <N> --repo R` **当场执行**。每张 PR 只合一次（账本 `mergeAsk` 记 `merged`/`failed`），
  冲突只记录、不 force merge；合完/合失败都不回执通知，原因看账本与控制台。
- **收尾按节点自清**（`src/workflow/cleaners.mjs`）：每个 workflow 节点只清自己产生的东西，漏一步不连带别的节点——
  `merge` 落合并事实（`mergeAsk` / 队列），`close` 关单 + 摘 `ready-for-agent` + 工单 `done`，
  `pr-open` 把 PR 记成 merged（记录留着给 prWatch 去重），`dispatch` 摘执行会话监听并收掉 `sessions` 记录，
  `workspace` 关 herdr 工作区 / 删 worktree / 删本地分支，`cleanup` 兜底（空目录、git 元数据、队列残留），
  `archive` 归档执行会话。合并没带 `--issue` 时按 PR 反查工单（流程实例 → 账本 `pr` 字段），close 节点不会空转。
- **`deliver` 管「通知往哪去」**：`mode: "new"`（默认）每次新建会话投递，`promptFile` 是**派单提示词**的路径（可选），
  `mergePromptFile` 是**合并提示词**的路径（可选，留空回落 `promptFile`），
  **两者都留空就用代码内置的** `src/builtin/dispatch-prompt.md` / `merge-prompt.md`（提示词随代码走，不再依赖 `~/.foreman/prompts/` 下的运行时副本）；`projectDir` 是写进首句的监控项目，
  `waitFirstReply: false` 表示只确认首句送达、不等第一轮回复。`mode: "existing"` 退回塞回已有会话。
- **notify 节点保留、暂时只落痕**：会话跑完后服务照常判结论、推进状态、记指纹，
  notify 节点落一次 `notice.delivered` 痕，但**不向谁发消息**（不新建派单会话、不 `dws notify`、不带续接催办）。
  要恢复投递看上面「通知口径」。
- **`--notify` / `--no-notify` 只管登记**：`foreman run --notify <会话id|标题>` 把这一轮派出会话的通知目标写它；
  `--no-notify` 表示这一轮不登记监听。通知停用期间这两个开关只影响登记，不影响是否发消息（本来也不发）。
- **什么时候不发**：`notify.enabled: false`；结论不在 `notify.events` 白名单里（默认只发上面那 6 个，
  `working`/`planned` 不发；显式盯的 `session-done` 例外）；`existing` 模式下目标为空、或目标正好是被监听会话自己。
  投递本身失败只写 `service.log`、计 `dwsErrors`，不打断轮询。
- **`service.enabled: false`** 等价于每条命令都带 `--no-service`：不再握手、不自动拉起服务。
  `pidFile` / `logFile` / `service.http.portFile` 都可在配置里改路径（测试用临时目录）。
- `verify` 是逐条 `bash -lc` 跑在工作区里的验收命令；空数组表示只查"干净 + 有提交"。
- `herdr.enabled: false` 时退回原生 `git worktree add`（herdr 报错时也会自动退回，并写日志）。

## 状态文件

- 账本 `~/.foreman/state.json`（`issues` 记工单进度、`sessions` 记会话与 convId（`kind` 区分 `deliver:dispatch`/`deliver:merge`）、`watch` 显式登记的监听、`notified` 已通知指纹去重、`workflow` 记节点暂停与累计次数、`mergeQueue` 记待合并的 PR、`mail` 记验收请求与已处理的回信、`approvals` 记合并批准：`{ by, via: mail|user|cli, tag, note, at }`）
- 服务 `~/.foreman/service.port`（端口）/ `foreman.pid` / `service.log`
- 日志 `~/.foreman/run.log`
- 锁 `~/.foreman/run.lock`（只管派单/接单侧；进程死了或超 6 小时的锁会被接管，合并不碰这把锁）
- 工作区 `~/.foreman/worktrees/<仓库>/fix-issue-N`

工单状态：`planned` / `working` / `done` / `pr-open` / `needs-human` / `blocked` / `escalated` / `reset`。
`done`/`pr-open`/`needs-human`/`blocked`/`escalated` 都不会再被捞。

## 边界

- 会话负责"在 worktree 里改 + 自测 + `git push` + `foreman pr open` 开 PR"，边界写进首句提示词。
- **收口只有两条：建 PR（`pr open`）与合并（`pr merge`）**——账本要把 PR 挂到「单 + 会话」，合并要幂等。工单侧的读、建单、评论、改标签、关单都直接 `opencli gitea`，`herdr`、`dws` 会话也直连；这些动作只是不留痕于 `console.db`。
- 合并由服务在 `merge.enabled: true` 时执行，**走独立合并通道（1 并发）**，会话不合并；`verify` / `publish` 代码保留但没接线。
- 不做 force merge：合并失败就停下，工单留言交人。
- 豆包是单实例：用户自己开着豆包时 dws 会报 `app_busy`，整轮终止（不逐条重试），让对方 ⌘Q 后再跑。
- 用户正在用的工作区一行不动：所有改动都落在 worktree 里。

## 测试

```bash
npm test
```
