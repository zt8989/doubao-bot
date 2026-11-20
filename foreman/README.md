# foreman

接单编排，`doubao-bot` 工程里的子包（源码就在 `doubao-bot/foreman`，`npm link` 成全局 `foreman`）。
三个工具各管一段，foreman 只做"把活儿串起来"这件事：

| 谁 | 管什么 | foreman 怎么用 |
| --- | --- | --- |
| **gitea** | Gitea 读写（REST API，令牌在 `~/.foreman/gitea-token`，秒级返回） | `gitea search/issue-view/issue-comment/issue-edit/pr/pr-merge/close` |
| **herdr** | 创建 git worktree（同时挂到她自己的工作区视图） | `herdr worktree create --cwd <repo> --branch <分支> --base origin/<基线> --path <路径> --no-focus` |
| **dws** | 豆包会话（开会话、发指令、读状态/对话、打断） | `dws open/send/status/info/stop` |

foreman 自己不碰豆包内部实现（只走 dws 的命令行），也不手写 worktree（交给 herdr），
Gitea 侧一律走 REST（`gitea` 包/CLI）。

**架构：通用 workflow = 生命周期 + 适配器**（`src/workflow/`）。流程只认生命周期事件
（捞单 → 工作区 → 派活 → 监听 → 结论 → 合并 → 清理 → 归档 → 通知），豆包 / Gitea / herdr 的差异全部收在
`src/workflow/adapters/` 里；换会话载体或工单系统时写个适配器即可。详见 `docs/workflow.md`。

## 以编排会话为中心（默认）

router agent决定接单时，每张工单都有**自己的一条编排智能体会话**（`foreman-<仓库>-<单号>-编排`），绑定在 `issues[键].orchestrator`：

```
捞到工单 → hand：新建/复用这张单的编排会话，steer 工单进去（账本记 handed）
              ↓（编排读工单，自己决定怎么派）
         dispatch：建一工程一工作区 + 开工作会话，会话 id 绑回编排（issues[键].agentConvId / .orchestrator）
              ↓
         工作会话只改代码、自测、commit 并给普通最终回复；router agent发现收工后按需 watch poll
              ↓
         状态与最终回复写入 task.update Inbox → Worker queue 给本单编排，不解析 RESULT、不自动开 PR
              ↓
         编排核对提交、diff、测试与工单，统一决定 pr open / resume / pr merge / clean
              ↓
         失败/卡住 → 编排先归因：原会话能修正才 resume <执行会话id>；需要协作就补派并登记归属
              ↓
         编排核对 → pr merge（合并即关单）→ clean：清 worktree、本地分支、工作会话与监听（幂等）
```

- **按单独立**：router agent或人工接单时 `ensureIssueOrchestrator` 按工单幂等——这张单已有 `convId` 就复用，不重复开；不同工单绝不共用。确认原编排失联时才用 `foreman hand <键> --fresh` 重派独立编排。
  用户自己发起的会话不需要另起：发起方就是编排（见下）。PR 扫描只通知router agent，由它 `pr assign` 后才新建「合并会话」。
- **编排会话从哪来（两种都绑同一种字段 `issues[键].orchestrator`）**：
  1. **router agent接单**：它先 `foreman run --dry-run --once` 核对优先级与空余容量，确认后 `foreman run --once`，由 `hand` 新建/复用这张单自己的编排会话；
  2. **用户自主发起**：用户在某个豆包会话里调 `foreman dispatch`（或 hand/resume），
     发起方会话 id（`--orchestrator <id>`，不传则取 `MCP_VM_CONVERSATION_ID`）直接绑成这张单的编排，
     工作会话的更新经 `task.update` Inbox 由 Worker queue 回那条发起方会话，不会再另起编排会话。
- **绑定**：`dispatch` 把工作会话写进账本（`agent` / `agentConvId` / `orchestrator`，会话记录 `kind: "worker"`、`parent: <编排 id>`）。
- **失败先归因**：原会话能修正时，`foreman resume <执行会话id>` 用 `dws msg --mode steer` 把「接着跑」插进指定会话，命令不收工单号；需要其他智能体时由编排补派并登记监听，完成后由 Worker queue 回等待结果的原会话。
  续跑计数与 `lastFailure` 都写账本。
- **收尾两步**：`pr merge` 合并关单 → `foreman clean <键>` 清残留 worktree / 分支 / 工作会话，并归档**这张单自己的编排会话**（worktree 有未提交改动就保留，不删别人正在写的东西）。
  clean 只认 `book.sessions` 里 `kind: "orchestrator"` 且带这张单 `issueKey` 的会话：全局编排和「用户发起方就是编排」的会话不归档。
  编排会话万一没被 clean 收掉（比如它没跑完、或 clean 时正是命令发起方），router agent或人工执行 `watch poll` 时会把**已收口（done/cleaned）**工单的编排会话补归档一次（还在跑的不动，后续再收）。
- **降级**：`sessionFlow.enabled: false`（或 `foreman run --direct`）只退回老的工单多会话模型；PR 仍由router agent显式 `pr assign`，不恢复扫描器自动建合并会话。

配置（默认已开，不用写也能用）：

```json
"sessionFlow": { "enabled": true, "name": "", "promptFile": "", "projectDir": "", "waitFirstReply": false },
"pickup": { "handToOrchestrator": true }
```

## 一轮做什么

```
gitea 读 ready-for-agent 工单
      ↓
herdr 从 origin/<base> 开 worktree（分支 fix/issue-N）
      ↓
指定原工单右侧的分支 / Git 标签（Issue.ref；分支不变时不重复 PATCH）
      ↓
dws 开会话，把工单 + 边界 + 普通最终回复要求一次发进去（不要求 RESULT）
      ↓
记账 + 登记监听与所属编排 → 返回 dispatched（会话随后自己改、自测、commit）
```

run 到这里就返回：**不在进程里等回复、不解析 RESULT、不验收、不 push/PR、不直接通知编排**。
代码不再按 `pollSeconds` 定时读取执行会话；router agent发现会话已收工后按需执行 `foreman watch poll`，状态变化与普通最终回复写入 `task.update` Inbox。Worker 再 queue 给本单编排，成功投递后才消费回复指纹并标记 idle。
是否已完成、是否 push/开 PR、续跑、合并、修改工单业务状态与收尾，都由编排智能体核对提交、diff、测试和工单后统一决定；Foreman 不根据最终回复自动补这些业务动作。
`verify` / `publish` 的旧代码路径不作为当前入口；需要开 PR 时由编排显式执行 `foreman pr open`。

worktree 建不出来时 run 当场 hold：回帖工单 + 打标签（`ready-for-human` / `agent-blocked`），返回 blocked。

会话最终回复说明缺少信息或受阻时，由所属编排判断是否改单、续跑或交人处理；**worktree 留着**，
人处理完 `foreman retry <仓库> <工单号>` 放回队列。

## 两条通道：派单与合并彻底分开

派单（接活、开会话、续跑）与合并（合 PR、关单、清工作区）是两件独立的事，走**两条独立通道**，各排各的队、各用各的并发，互不阻塞：

| 流程 | 干什么 | 并发 | 谁在推进 |
| --- | --- | --- | --- |
| **自有工单（own）** | 接单 → 建工作区 → 派活 → 开发 → 出 PR → 合并 → 关单 → 清理 → 归档 → 通知 | **同时最多 2 条在跑**（按 workflow 实例数算） | router agent按需接收 queue，决策后调用 `foreman run` |
| **他人 PR（review）** | 扫到 → 核对/判可合 → 解冲突 → **合并助手直接执行 `foreman pr merge`** → 关单 → 清理 → 归档 → 通知 | 不占接单名额 | 「他人 PR 扫描」定时器 + 合并助手 + `runMergeTask` |

- **合并通道已取消**：没有独立 lane、没有合并定时任务、没有独立并发槽（`src/lanes.mjs` 已删除）。
  `foreman pr merge` 当场执行合并，进程内一条串行链兜住并发，账本照样写。
- **合并助手核对后直接合并**：`foreman-合并-*` 会话收到「PR 待合并」后核对归属/基线、帮解冲突，
  可合就逐条执行通知里的 `foreman pr merge`，由 `runMergeTask` 当场合并并收尾，**不交 RESULT**。
  不可合或需要人工拍板时直接用普通文字说明原因；服务不再读取合并会话结论，也不再根据 RESULT 二次合并。
- **`pickup.maxRunning`（默认 2）** 限制router agent调用 `foreman run` 或人工调用 `foreman pickup` 时的「自有工单流程在跑数」：`engine.active("own").length` 到顶就 `skipped: "slots-full"`；
  账本 `planned`/`working` 的单数只作兜底，服务重启时 `engine.restore(book)` 会把在跑的实例补回来。
  每轮补单数 = `min(maxRunning - 在跑数, maxPerRound)`，所以 `maxPerRound` 默认也跟着变成 2（空着两个槽就一轮补两条）。
  **agent 主动调 `foreman dispatch` 不读这个上限**，即使候选巡检已经 `slots-full` 也仍可派单。
- 派单侧仍靠 `run.lock`（含 CLI `foreman run`）；合并不在定时器里跑，所以「正在合 PR」不会挡「正在派单」。
- 会话层也分开：**派单会话**（`foreman-派单-<时间戳>`，读派单提示词，只做续跑/接单）与**合并会话**
  （`foreman-合并-<时间戳>`，读合并提示词，判断可合性 + 解冲突 + 直接执行 `foreman pr merge`）。账本 `sessions.kind` 记 `deliver:dispatch` / `deliver:merge`，
  `sessions.notice` 记触发类型。
- 派单判定完一条会话，**不当场合并、不入队、不自动开 PR**：`watch poll` 只把最终回复交给所属编排；
  编排核对后显式 `foreman pr open` / `foreman pr merge`，每次续跑仍使用原工作会话。
- 合并结果不另开会话、也不回执：`foreman pr merge` 触发的合并只落账本 + 控制台
  （`mergeAsk` / `mergeTask` / `pr_merge`），关单 / 清工作区 / 归档做完即收工。
  命令本身**同步回包**（`merged` / `alreadyMerged` / `closed` / `cleanup` / `worktree` / `elapsedMs` / `summary`），
  调用方拿这一条就是最终结论，不用等任何后续消息；失败同样当场回 `merge-failed` + 理由。
- **合并要指明「工程 + worktree」**：日志、控制台 `pr_merge`、CLI 回包都写成 `工程 <仓库> · worktree <路径>`；
  worktree 取账本里这条单的实现工作区（一工程一工作区时按 PR 所在仓库对号），别人的 PR / 没有工作区时写
  「无 worktree」并留一行说明；本地清理的每条 notes 也带路径（`worktree 已删除：<路径>`）。
- `foreman status` 里能看：`pickup.maxRunning / inflight`、`lanes.dispatch.workflowActive`、`merge.queued`、
  `workflow.{workflows,stages,nodes,active,runs,recent}`。

## 常驻服务与router agent

常驻服务在同一个 Node 进程里运行 **Schedule 执行 script/agent → 有效信息写 SQLite Inbox → 单 Worker**，保留五类持久 Schedule：我的工单扫描、执行会话代码轮询、他人 PR 扫描、验收邮件、每日记忆 dreaming。`pickup` 每 5 分钟筛选 open、指派给 `pickup.me` 且带 `ready-for-agent` 的工单，只把候选写入 router agent Inbox，不直接派单；`watch poll` 把已登记执行会话的 `running/gone/finished/settled` 状态写成 `task.update`，代码每 1 分钟轮询执行收工。

- Schedule 到期先推进 `next_at`，再按定义直接执行 script 或调用 agent。我的工单扫描调用 `src/service.mjs#pickupPollOnce`，执行会话轮询调用 `src/service.mjs#pollOnce`，PR 扫描和邮件轮询沿用原脚本，每日记忆 dreaming 新建独立 Agent。只有失败、实际业务活动或脚本显式声明的 `{type,text,json}` 才写成 `schedule.event`；普通“执行完成 / queued / checked”回执直接跳过。工单候选另写带 `issue.candidates` 与工单列表 JSON 的 `router.notice`，PR 候选写 `pr.candidates`，不重复写扫描摘要。
- `agent_inbox` 是投递事实源：相同来源的活跃事件去重；支持按 `coalesceKey` 合并尚未开始的 pending；同一任务的 pending 状态合并为最新状态；过期 pending 直接丢弃；处理失败 30 秒后重试，重启通过租约恢复 processing。
- `task.update` 按工单绑定的 `orchestrator` 路由，补派任务其次取 `parent` / 显式通知目标，完全没有归属的旧任务才回退router agent。完成状态携带普通最终回复原文；Worker 成功 queue 后才写 `notified` 与 `idle`，只入箱不算已消费。若 dws 明确报「侧边栏里没有任务」，Worker 把同一事件附上原目标不可达的说明兜底交router agent；其他 queue 异常仍按原错误重试。不同任务的事件逐条完成，避免一条失败导致另一条已送达任务被重投。
- Worker 收到普通消息写入后直接 `wake()`，1 秒轮询只负责漏唤醒与重启恢复。对 `schedule.event` 先按 `payload.type` 找直接处理器，找不到或无法识别的内容连同 text/JSON 交router agent判断；多条路由通知合并成一次运行。旧 `schedule.result` 只标记 `non-actionable` 丢弃，不再确认或转发。
- 以最后一次成功投递为轮换基准；从未成功时从首次失败计时，连续 `router.recreateAfterHours`（默认 24 小时）未成功才新建路由会话。普通 Inbox 消息的 done 只表示 Worker 已成功交给处理器或 dws，不表示 Agent 已处理完。
- `pickup` Schedule 只读取并筛选工单候选，不自行派单，Worker 也不替router agent做业务决策。router agent收到 `issue.candidates` 后先核对实时容量，再对通知中明确列出的工单执行 `foreman hand <owner/name>#N`，由该单编排会话 `dispatch` 编码智能体；不得用 `run --once` 扩大候选范围。router agent还负责健康检查、必要时 `hand --fresh` 重派独立编排、用 `issue settle` 修复本地完成状态。每轮先读 `foreman tasks --json`：主体是 `sessions` 父子树，节点 `state=running/idle/gone/unknown` 为会话状态，`issueKey/issueState` 仅作归属与容量元数据；在飞数取 `summary.unresolvedIssues`，PR 数取 `summary.prOpenIssues`，真实编码运行数只数编码节点 `state=running`。每轮执行 `foreman clean --all` 幂等清理 `done/cleaned` 残留。全部未收口合计最多 `pickup.maxRunning`（默认 2），`handed` 占槽，不是每轮新增 2 张；dry-run 只看候选优先级，满额禁止 `run/pickup/hand/orch start/dispatch`，每次接单后重新计数。每轮先读 `foreman tasks --json`：主体是 `sessions` 父子树，节点 `state=running/idle/gone/unknown` 为会话状态，`issueKey/issueState` 仅作归属与容量元数据；在飞数取 `summary.unresolvedIssues`，PR 数取 `summary.prOpenIssues`，真实编码运行数只数编码节点 `state=running`。每轮执行 `foreman clean --all` 幂等清理 `done/cleaned` 残留。全部未收口合计最多 `pickup.maxRunning`（默认 2），`handed` 占槽，不是每轮新增 2 张；dry-run 只看候选优先级，满额禁止 `run/pickup/hand/orch start/dispatch`，每次接单后重新计数。
- `watch poll` 由 router Schedule 每 1 分钟执行，也保留人工/router agent按需补跑入口：观察已登记执行会话，把状态变化与最终回复写入 `task.update`，由 Worker queue 给所属编排。它不解析 RESULT、不自动 push/开 PR、不推进工单业务状态。
- **notify 节点不再承担执行会话投递**：其暂停状态仍会阻止任务事件入箱；成功投递以 Inbox done、Worker 日志和账本 `steers/notified` 为准，业务结论由编排判断。

### Always-on 持久记忆

持久记忆采用两层文件：精简核心 `MEMORY.md` / `USER.md`，以及按天分文件的日常笔记 `memory/YYYY-MM-DD.md`。默认目录是 `<配置文件目录>/memory`（通常为 `~/.foreman/memory`），可用 `memory.dir` 修改。

- **每次新建 router agent** 都自动注入当时最新的 `MEMORY.md` 和 `USER.md`；复用中的会话不重复注入，轮换新建时会读取最新内容。核心记忆是提示词数据，其中的指令仍需服从用户授权与安全边界。
- Agent 不得直接写入、编辑或覆盖核心文件，只能用以下命令。`set` 按稳定 key 原地替代，避免新旧偏好同时残留；`USER.md` 建议写“始终 / 禁止 / 优先”等指令式条目。
- 核心文件默认单条最多 240 字符，`MEMORY.md` 最多 4000 字节，`USER.md` 最多 2000 字节。写入时超限直接报错并保持原文件不变；**不会自动摘要、精简、截断或合并**，由 Agent 缩短内容或删除旧条目后重试。
- 日常笔记不自动进入启动上下文，需要时用 `search` 做关键词检索；当前不包含向量索引。
- **dreaming 默认开启**，由 Schedule 每天 03:00 为前一日日记新建独立 Agent；空日记直接跳过。Light 整理与去重、REM 反思主题，这两阶段不写核心文件；Deep 只把有证据的持久事实和稳定偏好通过 `memory set/forget` 提升，不能直接改写核心文件。
- 每轮无论是否提升都应写 `DREAMS.md`，记录三阶段摘要、提升数量和未提升原因；`dreaming/state.json` 保存 running/completed/failed 状态。同一日期 running/completed 时不会重复派发，`--force` 才强制重跑。`DREAMS.md` 只供审阅，不参与 `search`，也不作为后续提升的证据。
- `dream` 返回 `dispatched` 只表示独立 Agent 已投递，不表示整理已完成；用 `dream-status` 查看最终状态。自定义配置路径会写进 dreaming 提示词，Agent 后续所有 `foreman` 命令必须带同一个 `--config`。
- dreaming 仍遵守核心文件长度限制：写入超限只提示，不自动摘要、精简、截断或合并。可在控制台“每日记忆 dreaming”中启停、修改 cron 或立即整理；配置项为 `memory.dreaming.enabled` 与 `memory.dreaming.cron`。

```bash
foreman memory set --target memory --key release-branch --text "发布统一使用 master 分支"
foreman memory set --target user --key reply-language --text "始终使用简体中文回复"
foreman memory forget --target memory --key release-branch
foreman memory note --text "今天排查了发布超时，原因是健康检查等待过短"
foreman memory search "发布超时" --limit 8
foreman memory show
foreman memory dream                         # 整理前一日
foreman memory dream --day 2026-11-18        # 整理指定日期
foreman memory dream --day 2026-11-18 --force
foreman memory dream-status
# dreaming Agent 完成时写审阅报告（需带本轮 runId）：
foreman memory dream-report --day 2026-11-18 --run <runId> --text "Light/REM/Deep 摘要"
```

### Outbox：邮件与飞书统一外发

业务代码只把外发意图写入同库独立表 `agent_outbox`；同一个 Node 进程里的单 Dispatcher 收到写入后直接唤醒，串行调用 `agently-cli` 或 `lark-cli`，1 秒轮询只补漏与恢复重启。Outbox 与 Agent Inbox 分工不同：Inbox 把事件交给 Agent，Outbox 把消息送到外部通道。

```bash
foreman send --type mail --to a@x.com,b@y.com --subject "发布结果" --body "已完成"
foreman send --type lark --chat-id oc_xxx --text "已完成"
foreman send --type lark --user-id ou_xxx --markdown "## 发布结果\n\n- 已完成"
foreman outbox list [--limit 100] [--status pending|processing|sent|failed] [--channel mail|lark]
foreman outbox run                 # 排障时手动消费一轮
```

- `send` 返回 `pending` 只表示已持久化，不表示外部已收到；`sent` 才表示 CLI 发送成功。失败默认 30 秒后重试，最多 `outbox.maxAttempts`（默认 8）次，最终记 `failed`；过期 processing 租约重启后恢复。
- 可选 `--dedupe-key <稳定键>` 跨全部状态去重。Lark 使用 `fm-<事件UUID>` 作为供应端幂等键；邮件没有供应端幂等键。若进程恰好在外部已发送、本地尚未写 sent 时崩溃，仍可能重复，不能宣称绝对 exactly-once。
- 验收邮件先记 `queued`，Dispatcher 发送成功后才记 `waiting` 并开放回复等待；最终失败记 `send-failed`。催办在上一封仍 pending 时不会重复入队。
- 统一入口只有 `foreman send --type mail|lark`；旧 `foreman mail send` 已删除，也不提供 `foreman lark send`。Lark 当前支持纯文本/Markdown，接收目标二选一：`--chat-id` 或 `--user-id`，默认用户身份（`lark.as: "user"`）。
- **普通邮件回复路由**：CLI 发邮件时自动把 `--session-id`（未传则取 `MCP_VM_CONVERSATION_ID`）写成主题末尾的 `[FM-SID:<会话ID>]`。收件轮询把非验收邮件写成 `mail.reply` 持久事件；Worker 先查会话是否存在，命中后 steer 回原会话，未携带或未命中 ID 的回复交给 router agent。同一 `message_id` 只入箱一次，DWS 临时故障保留事件重试。
- `[FM-SID:…]` 与 UI 验收的 `[FM-xxxxxxxx]` 是两种标记；验收回复仍走原有白名单、判定与合并流程，不进入普通邮件路由。旧 `inspector` 配置、账本字段与 Inbox 事件只作兼容读取，新口径统一使用 `router` / router agent。

### 起与停

```bash
foreman serve                 # 前台跑（Ctrl-C 停）
foreman serve --daemon        # 后台跑，输出进 service.log
foreman ping                  # 在不在：pid / version / uptime / 在听几条
foreman status                # 在不在 + 监听明细 + Inbox/Schedule/Worker 状态
foreman inbox list [--limit 100]  # 事件、投递状态、duplicate/superseded/expired 原因
foreman worker run             # 手动消费一轮（排障；正常由 wake/轮询驱动）
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

测试实例可用 `FOREMAN_CONFIG_DIR=<目录> foreman serve` 启动：服务从该目录读取 `config.json`，未显式配置的 `state.json`、SQLite、pid、日志、端口文件、token 与记忆目录都落在该目录，避免与正式的 `~/.foreman` 混用。监听端口仍由 `config.json` 的 `service.http.port` 配置；显式 `-c <配置>` 优先于环境目录，配置文件里显式写出的路径不会被环境目录改写。

```json
{
  "service": {
    "http": {
      "host": "127.0.0.1",
      "port": 7317,
      "portFile": "~/.foreman/service.port",
      "db": "~/.foreman/console.db"
    }
  },
  "inbox": {
    "pollMs": 1000,
    "schedulePollMs": 1000,
    "retrySeconds": 30,
    "leaseSeconds": 900
  },
  "outbox": {
    "pollMs": 1000,
    "retrySeconds": 30,
    "leaseSeconds": 120,
    "maxAttempts": 8
  },
  "lark": { "bin": "lark-cli", "as": "user" }
}
```

Inbox、Outbox 与 ConsoleStore 共用 `~/.foreman/console.db` 的同一连接，使用 `agent_inbox` / `agent_schedules` / `agent_schedule_settings` / `agent_outbox` 独立表；定时任务的开关、cron、脚本/Agent 定义与工作时间窗只以 SQLite 为准，旧 `config.json` 仅在首次初始化时提供迁移值。不使用 SQLite Trigger 唤醒 Node，也不另起 Worker 或 Dispatcher 进程。

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
  （接单标签 `pickup.labelIds` 只管router agent的候选巡检，不管这里），账本里已处理（`done` / `pr-open`）、已交编排（`handed`）、
  在飞（`working` 且无失败）、试到 `maxAttempts` 上限的不列；按归属分「我的 / 无人认领 / 他人认领」；
  **按归属排序（我的 → 无人认领 → 他人认领），同档按创建时间老的在前，最多显示 10 条**，响应里 `total` 是全量条数，
  超过 10 条时页脚会写明「共 N 条待分配 · 只显示前 10 条」；
  点行尾「接单」= 建工作区 + 开执行会话，**显式人工动作，不受工作时间限制**，但 `run.lock`、节点暂停、账本查重照旧守着，
  不会和 CLI / router agent把同一张单派两遍。页脚显示「在跑 n/上限」。
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
  - 「定时任务」列出我的工单扫描（`pickup.auto`）、执行会话代码轮询（`router.enabled`）、他人 PR 扫描（`prWatch.enabled`）、验收邮件（`mail.enabled`）、工作时间窗（`workHours.offUntil` 临时闭嘴）等持久任务，带运行状态、上次时间、下次触发与已跑轮数；
  - 三项任务的时间都可编辑 **cron 表达式**，脚本路径、导出函数和参数可在编辑区修改；对应配置 `router.cron` / `prWatch.cron` / `mail.cron`。没配 cron 时兼容 `intervalSeconds`，折成分钟级表达式；
  - 点「开启/停止」或「保存时间」会 `POST /api/schedules`（如 `{"patch":{"router":{"enabled":true,"cron":"*/10 * * * *"}}}`）：先校验并改内存 cfg、再写入 SQLite、然后立刻重排定时器，**不用重启服务，也不再写回 `config.json`**；非法 cron 返回 400，不会落盘；
  - router agent的「立即巡检」走 `POST /api/schedules/run`，等价于手动 `foreman route`；它只是提前写入 Inbox，由 Worker 投递，不代替智能体决策。
  - `GET /api/schedules` 返回同一份状态，脚本/CLI 也可用。
  - **自定义 Agent 型定时任务**：旧 `config.json` 的 `agentSchedules` 会在首次初始化时迁入 SQLite，之后以 `agent_schedules` 中的定义为准；每条包含
    `{ "id", "label", "cron", "enabled": true, "prompt", "cwd", "detail" }`，列表独立成行，徽标是 **Agent**。
    `cwd` 是这条任务的工作目录：省略就等于脚本所在位置（当前运行的 foreman 包目录，发布后是 `dist/foreman`，从源码跑则是 `foreman/`），`~` 会展开、相对路径按包目录解析；
    到点投递的提示词里会写明这个目录，记日志、写文件都按它定位。改 `cwd` 也走 `agent.cwd` 补丁，传空串即回默认。
    到点由服务用 `dws open --no-wait` 新开一条 `foreman-<id>-<时间戳>` 会话，把提示词作为首句投递；
    不投给 router agent、不写 Inbox，跑完在会话里直接给最终回复。id 不能与内置任务重名。
    页面编辑区可改开关、cron 与提示词，保存同样走 `POST /api/schedules`；「立即执行」走 `POST /api/schedules/run`。
  - **脚本型定时任务只认绝对路径**：`pickup` / `prWatch` / `router` 的入口是当前运行副本里的 `src/service.mjs`，
    `mail` 是 `src/mailflow.mjs`，默认值由 `src/core/executors.mjs` 按包目录拼成绝对路径；没有相对路径分支，
    配了相对路径直接报「定时脚本必须是绝对路径」，不再猜按谁解析。
- **「操作日志」页面**：派单、投递编排通知、建/合 PR、合并后清理、执行会话归档都会先记一条「进行中」，结束再更新为「成功 / 失败」；服务重启时未收尾的记录标为「已中断」，不会永远显示正在执行。支持按状态筛选，每 15 秒自动刷新。
  - 数据在同一个 `console.db` 的 `operations` 表；查询接口 `GET /api/operations?limit=100&status=running&action=merge`（后两个参数可省略）。
  - 同时写一份到 `service.log`，前缀为 `[操作]`；日志写不进去不会阻断派单或合并主流程。

### 监听地址与外部访问

`service.http` 里的 `host` / `port` / `tokenFile` 就是唯一来源，代码里不写死；`host` 默认 `127.0.0.1`。

- 想让局域网 / tailscale 访问，把 `host` 改成 `0.0.0.0`（监听所有网卡），`port` 按需改。
- 只要监听地址不是回环，服务会自动生成访问 token 到 `~/.foreman/console.token`（0600）；
  外部来源必须带 `?token=<token>`（第一次带会自动下发 cookie）、`x-foreman-token` 头或该 cookie，
  否则页面和 `/api/*` 一律 401。本机回环请求免验，CLI 不受影响。
- 启动日志与 pidFile 会列出本机各网卡入口（含 tailscale 的 `100.x`），token 只写文件不写日志。
- CLI 连接地址同样读配置：`host` 是 `0.0.0.0`/`::` 时按回环连，否则连配置里的 host；端口优先读 `service.port`。

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
foreman watch poll                       # 立刻跑一轮（checked / settled / enqueued），取证补漏
```

在听的会话 = 这轮 run 派出去的（自动登记）∪ `watch add` 显式盯的，按会话去重，显式优先。

代码不再每 `pollSeconds` 自动轮询。router agent或人工执行 `foreman watch poll` 时，先 `dws list --json` 读一次侧边栏（不切窗口），**以侧边栏的 `running` 为监听主判据**：

- `running` 真 → 首次观察到该阶段时写一条 `task.update`，不调用 `dws status` / `dws info`（这两个内部都要 `goto`，不读才不会把用户窗口拽走）；
- `running` 假、且这次收工已经由 Worker 成功投递 → 直接跳过，一个字节都不读（`notified` 里记 `idle`）；
- `running` 假、还没处理过 → 收工这轮读一次 `dws status` 和最终回复，写入 `task.update`；Worker 投递成功后才落 `idle`；
- 侧边栏再把它报成 `running` 时清掉 `idle`，等下一次收工重新判一轮。

读不到侧边栏（`dws list` 失败）时，尚未消费的会话仍退化为逐条 `dws status`；一旦最终回复已由 Worker 投递就同样落 `idle`，不再每轮重读。后续由侧边栏重新出现 `running`，或 `resume` / 重派 steer 显式清掉 `idle`，再读取下一次结果。

router agent决定执行 `run` / `pickup` 时也会先读侧边栏，但**默认不因此停派**（派单通道要并行 2 张单）：只有显式打开 `pickup.pauseWhileRunning: true` 时，才有在跑会话就跳过本轮（`window-busy`）。

收工那轮对 `dws status` 的判定：

- `streaming` 真 → running，不动；`chars: 0`（dws 的"还没开始"坑）→ pending，不动。
- `finished` 真 → finished；finished/streaming 都假但 `chars > 0` 且有 status 文本 → settled。只有这两种算跑完。
- 指纹 = `sha1(chars|head|tail)` 前 12 位。**跑完 + 指纹相对上次已投递的指纹变了**，才写完成事件；
  同一个 `(会话, 指纹)` 只由 Worker 成功投递一次，去重记在 `state.json` 的 `notified` 键——**服务重启也不重发**。

### 任务事件投递：Inbox / Worker 只路由，编排判业务

- `watch poll` 把 `running/gone/finished/settled` 状态写入 `task.update`；完成状态同时保留 `dws.info` 的普通最终回复原文，不解析 RESULT，也不把 finished/settled 当成工单完成。
- 入箱时按 `issues[键].orchestrator` → 补派 `parent` / 显式 `notifyTo` → 全局编排 → router agent的顺序确定并固化归属；Worker 按事件里的归属 `dws msg --mode queue` 投递，不广播、不新建派单会话、不 steer。
- 同一任务的 pending 更新合并为最新状态；不同任务逐条投递。失败保留事件并重试，重启由 SQLite 租约恢复；Worker 成功交给 dws 后才消费 `(会话, 指纹)` 并落 `idle`。
- 编排收到最终回复后核对提交、diff、测试和工单，自行决定 `pr open`、`resume`、`pr merge`、`clean` 或修改工单业务状态。代码不自动 push、开 PR 或补业务结论。
- notify 节点的暂停开关仍会阻止任务事件入箱；PR 扫描与验收邮件仍走各自 Inbox 事件。`--no-notify` 仍表示这一轮不登记监听，因此不会产生该执行会话的 `task.update`。

### 服务没在跑时，结论没人判

服务没跑时，代码定时轮询不会发生，已收工会话也不会被自动读取。补法：

1. `foreman watch list` —— 登记在账本里，不依赖服务活着，先看会话还在不在听。
2. `foreman watch poll` —— 立刻重放一轮，已跑完且指纹没通知过的会补发。
3. `foreman status` —— 看 `lastPollAt` / `pollCount` / `dwsErrors`，判断服务是没在跑，还是在跑但一直出错。

## 工作时间窗

我的工单扫描与他人 PR 扫描只在 `workHours` 窗口里跑；执行会话代码轮询与验收邮件不受工作时间窗限制：

```json
"workHours": { "enabled": true, "days": [1,2,3,4,5], "start": "08:30", "end": "18:30", "offUntil": "" }
```

- `days`：1=周一 … 7=周日；`start`/`end` 左闭右开（到 18:30 就停）
- `offUntil`：临时闭嘴时间点（ISO 带时区），到点自动恢复
- 不配 `workHours` 或 `enabled: false` = 我的工单与 PR 扫描全天跑；手动 `foreman pr poll` / `watch poll` / `inspect` 及 pickup「立即扫描」不受窗口限制
- `foreman status` 里 `workHours.active` 显示当前是否在窗口内

## PR 监听（默认 5 分钟一轮）

服务里还有一条独立定时器，每 `prWatch.intervalSeconds`（默认 300s）扫一遍 `repos[]` 下各仓库的 open PR：

- 列表走 `gitea pull-list --repo <owner/name> --state open`（REST 列表，带回 `author`/`base`/`head`）。
- 本人账号（`prWatch.ignoreAuthors`，当前 `233151`）的 PR 不进入他人合并助手链路。本人 PR 若涉及 UI，代码读取 PR 文件列表确认后，另发「本人 UI PR 待验收指派」给router agent；非 UI 仍只记 `skipped: "self"`。作者不明记 `skipped: "unknown-author"`，不进入候选。
- 其余 PR 合成候选消息，写入 `router.notice` Inbox；Worker 复用同一路由会话投递。router agent不主动读取 PR 列表，只处理代码送来的候选；决定处理时执行 `foreman pr assign <N> --repo R`，Foreman 再校验作者，确认为他人 PR 后才新建合并会话。
- 本人 UI 候选由router agent执行 `foreman pr ui-assign <N> --repo R`；Foreman 复核 open、本人、UI 和既有指派人后，按 `prWatch.uiReviewers` 顺序轮询指派。当前顺序为周晓亮（`ywwb1328`）→ 张振豪（`ywwb1797`），只改 Gitea 指派人，不建合并助手、不合并；成功后才推进游标，重复执行幂等。
- 有冲突的 PR 默认过滤（`prWatch.filterConflicts`，查 `pr-view` 的 `mergeNote`），不合也不报。
- **扫描器不直接建合并助手、不合 PR**：分配入口会拒绝本人或作者不明的 PR，重复分配幂等。合并助手核对归属/基线、解冲突，可合就执行通知里的 `foreman pr merge`，不可合或需要拍板就用普通文字说明原因，不交 RESULT。
- 去重分两层：Inbox 按通知正文 SHA-256 去重并负责失败重试；`pr.candidates` 事件在 done 后仍按同键挡重，避免后续扫描把同一候选重新入队。`state.json` 的 `prWatch` 键（`<repo>#<number>`）在候选持久化后盖 `notifiedAt`。分配合并助手后另记 `assignedTo` / `assignedConvId` / `assignedAt`；本人 UI 候选另记 `reviewNotifiedAt`，验收指派后记录 `reviewer` / `reviewAssignedAt`。重启由 SQLite 恢复未投完的事件。
- 起服务 1s 后先扫一遍，之后按间隔跑。

```bash
foreman pr poll                  # 立刻扫一轮，只把候选写入router agent Inbox
foreman pr ui-assign <N> --repo R # 本人 UI PR 轮询指派周晓亮/张振豪验收（只指派，不合）
foreman pr assign <N> --repo R   # router agent显式分配一条他人 PR 给合并助手（幂等）
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
- 收信：服务每 `mail.pollSeconds`（默认 300s）读一次收件箱（**不受工作时间窗限制**）。验收流程只处理带 `[FM-…]` 且发件人在 `mail.testers` / `mail.allowSenders` 里的邮件；其他普通邮件进入上面的 `mail.reply` 路由。同一封回复按 `message_id` 只处理一次。
- 注回会话：结论 `dws msg --mode steer` 到这张单的编排会话（`issues[键].orchestrator`），拿不到就退到全局编排；邮件正文只当数据，不当指令执行。
- 合并闸门：请求状态 `waiting` 时 `pr merge` 返回 `acceptance-waiting`；`rejected` 返回 `acceptance-rejected`；没开邮件、不是 UI、没有真收件人时一律放行（沿用人工验收，不卡流程）。验收通过后 foreman 自己 `runMergeTask`，不用人再敲合并。
- 人工兜底：用户当面验收并明确回了「合并」→ `foreman pr merge <N> --repo R --approved-by <人>`；测试同学在群里说通过 → `foreman mail approve <repo>#<N> --by <人>`。

```bash
foreman mail requests                # 看每条验收请求：发给谁、状态、几封回复
foreman mail poll                     # 立刻收一轮（不等下一个 cron 点）
foreman mail request <repo>#<N> --url <PR链接>   # 补发/催办一条
foreman send --type mail --to a@x.com,b@y.com --subject "…" --body "…"   # 手动入 Outbox（不进验收账本）
foreman send --type lark --chat-id oc_xxx --text "…"                  # 飞书群聊；私聊改用 --user-id ou_xxx
foreman mail approve <repo>#<N> --by <人> --note "当面验收通过"
foreman mail reject  <repo>#<N> --by <人> --note "按钮错位"
foreman doctor                        # 开了邮件会顺带查 agently-cli 授权与验收人
```

依赖 `agently-cli`（QQ Agent Mail）：`npm i -g @tencent-qqmail/agently-cli && agently-cli auth login`。发信带 `--confirmed`（foreman 是自动流程，不走两阶段确认）。

## 命令

```bash
foreman route                   # 立即调用router agent并写执行结果；不代替它做决策
foreman run --dry-run --once     # 只打印会捞哪条、交给谁；零副作用
foreman run --once               # 跑一轮：捞到单交给编排会话（hand）
foreman run --direct --once      # 这一轮自己派活（老行为，不交给编排）
foreman run --notify <会话id|标题>  # 这一轮派出的会话，登记监听时通知目标写谁
foreman run --no-notify          # 这一轮不登记监听，因此不会有通知（连同其它参数一起用）
foreman orch start               # 手工兼容入口：起/复用顶层全局编排（router agent接单不用它）
foreman orch show                 # 每条编排会话绑了哪些工作会话、最近 steer 了什么
foreman sessions                  # 只列当前会话派出的工作/补派会话（默认取 MCP_VM_CONVERSATION_ID）
foreman sessions --orchestrator <会话id>  # 终端里查询指定会话派出的全部会话
foreman hand <owner/name>#N [--fresh]  # 默认复用本单编排；确认原编排失联时才 --fresh 重派
foreman dispatch <owner/name>#N (--prompt <编排指令> | --file <指令文件>) [--repo <工程名|owner/name>]...
                                 # 默认只建工单所在仓；额外工程重复传 --repo，正文提到不会自动建
                                 # 提示词必填：编排分析、任务范围与验收随首句注入，头部带完整工单 ID 和 URL；重派随 steer 发送
                                 # 首句、重派和 resume 都附各原工程 repos[].dir/AGENTS.md 全文（文件存在且非空时）
foreman resume <执行会话id>   # 原会话可修正时：按会话 id steer 续跑（不新开、不传工单号）
                                 # 上面三条都支持 --orchestrator <会话id>：绑到发起方会话（不传取 MCP_VM_CONVERSATION_ID）
foreman clean <owner/name>#N     # 合并关单后清 worktree / 分支 / 工作会话（幂等）
foreman clean --all              # 清所有终端态工单的残留（worktree / 分支 / 会话）
foreman pickup                   # 手动/router agent处理一轮候选；没有代码定时器会自动调用它
foreman tasks                    # 已分配会话的实时状态与父子树；工单仅作节点元数据
foreman pr poll                  # 立刻扫一轮 PR，只把候选交给router agent
foreman pr ui-assign <N> --repo R # 本人 UI PR 轮询指派周晓亮/张振豪验收（只指派，不合）
foreman pr assign <N> --repo R   # router agent显式分配合并助手；本人/作者不明拒绝，重复分配幂等
foreman pr list                  # 看 PR 监听账本
foreman pr open --repo R --head <分支> --title "…" --body "…" --issue N   # 建 PR（唯一入口；--base 省略取配置 repos[].base）
                                 # 加了 --ui（或 diff 认出前端文件）就自动发验收邮件
foreman pr merge <N> --repo R --approved-by <人>   # 用户当面验收、明确回了「合并」时用这条过 UI 验收闸门
foreman mail requests            # 验收请求与回复状态
foreman mail poll                # 立刻收一轮回复
foreman mail request <repo>#<N> [--url <PR链接>]    # 补发/催办验收邮件
foreman send --type mail --to <邮箱> --subject "…" --body "…"      # 手动写入 Outbox
foreman send --type lark (--chat-id <oc_…>|--user-id <ou_…>) (--text "…"|--markdown "…")
foreman outbox list [--limit 100]                                  # 看 pending/sent/failed 与重试错误
foreman mail approve|reject <repo>#<N> --by <人> [--note "…"]
foreman issue comment <N> --repo R --body "…"   # 评论工单（记账）
foreman issue settle <N> --repo R --note "完成依据"  # 仅本地完成：不关 Gitea、不清 worktree、不合 PR
foreman issue close <N> --repo R                # 关单（记账）
foreman retry win-ai-harness 255 # 人工处理完，放回队列（attempts 清零）
foreman doctor                   # 自检：dws/gitea/herdr/仓库基线
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

### 执行会话轮询与按需 router agent（router）

`pickup.auto` 控制独立的我的工单扫描 Schedule，按 `pickup.cron`（未配置时由 `intervalSeconds` 换算）运行。扫描只筛选 open、指派给 `pickup.me` 且带 `ready-for-agent` 的工单，并排除账本中 `handed/planned/working` 与已收口的单；候选写 `issue.candidates` Inbox，由 router agent 按容量 hand，绝不直接调用旧 `pickupOnce` 派单。手动「立即扫描」只绕过开关与工作时间窗。`pickup.kickAfterDone` 仍是历史配置，`run --every` 仍拒绝执行。

- `router.enabled` 默认 `true`；起服务 1 秒后执行首轮代码轮询，之后每 `router.intervalSeconds`（默认 60 秒）运行 `src/service.mjs#pollOnce`；
- 脚本路径、导出函数和参数在设置页可查看与编辑，默认 `src/service.mjs` / `pollOnce` / `{}`；普通检查完成不写 Inbox，真实状态变化写 `task.update`；
- 连续 `router.recreateAfterHours`（默认 24）小时未成功投递才新建路由会话；这只适用于按需 Agent 投递，不影响代码轮询；
- 手动 `foreman route`、PR 候选、邮件异常和 Worker 未识别事件仍调用 router Agent。Agent 被调用时先 `run --dry-run --once` 核对候选，再决定是否 `run --once`；优先级仍由 `pickup.priority` 等配置决定，容量为 `pickup.maxRunning`；
- Agent 每轮以 `foreman tasks --json` 的实时 `sessions` 树和 `summary` 为准，只对 `done/cleaned` 执行 `foreman clean --all`，不得清理 `working/pr-open` 等非终态；
- 显式 `foreman pickup` 会绕过旧 auto 开关与工作时间窗，但保留容量、`run.lock`、节点暂停和账本去重；
- 执行会话收工由代码定时轮询处理，人工或 Agent 需要补取证时也可 `watch poll`；
- `foreman status` 的 `lastPollAt` / `pollCount` 查看代码轮询状态，`router` 段查看按需 Agent 会话与投递状态。

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
    "maxRunning": 2,
    "maxPerRound": 2,
    "pauseWhileRunning": false
  },
  "router": { "enabled": true, "intervalSeconds": 60, "recreateAfterHours": 24, "projectDir": "" },
  "memory": { "dir": "memory", "maxEntryChars": 240, "memoryMaxBytes": 4000, "userMaxBytes": 2000 },
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
    "uiReviewers": [
      { "name": "周晓亮", "username": "ywwb1328" },
      { "name": "张振豪", "username": "ywwb1797" }
    ],
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
- **`pickup.labelIds` 必须用数字 id，别用名字**。REST 的 `labels` 参数只认名字，foreman 会把 id 翻成名字再按 id 精确过滤，
  id 写错会直接报 `not_found`，不会再静默捞全量；`label-list` 能查名→id（`ready-for-agent` 当前是 5）。
- 配了 `labelIds` 后，结果再按 id 精确过滤一次（REST 的 `labels` 是“任一匹配”语义）。
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
- **收口只有两条：建 PR（`pr open`）与合并（`pr merge`）**——账本要把 PR 挂到「单 + 会话」，合并要幂等。工单侧的读、建单、评论、改标签、关单都直接 `gitea`，`herdr`、`dws` 会话也直连；这些动作只是不留痕于 `console.db`。
- 合并由服务在 `merge.enabled: true` 时执行，**走独立合并通道（1 并发）**，会话不合并；`verify` / `publish` 代码保留但没接线。
- 不做 force merge：合并失败就停下，工单留言交人。
- 豆包是单实例：用户自己开着豆包时 dws 会报 `app_busy`，整轮终止（不逐条重试），让对方 ⌘Q 后再跑。
- 用户正在用的工作区一行不动：所有改动都落在 worktree 里。

## 测试

```bash
npm test
```
