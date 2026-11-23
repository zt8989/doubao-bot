---
name: foreman
description: 交付一条龙 CLI（doubao-bot/foreman，命令 foreman）：建单 `issue create [--ws]`、开工作区+分支+回写工单右侧分支 `ws add`、建 PR `pr open`、幂等合并+关单+清尾 `pr merge`。执行载体配置 agent=dws|noop，noop（当前生效）下纯机械动作照常工作、不碰豆包，豆包过期也能用。用户提到建工单、开工单分支、worktree、建 PR、合并 PR 关单、foreman/工单/worktree 报错，或跨工程工单要开多个工作区时使用。
---

# foreman：交付一条龙

CLI 源码在 `doubao-bot/foreman`，已 `npm link` 全局；改源码 → commit → `node scripts/publish.mjs foreman` 才上线。常驻服务按需自动拉起（CLI 握手）。

## 两个可插拔的载体

- **执行载体**（`agent: "dws" | "noop"`，当前 **noop**）：豆包只是可选 agent 之一。noop 不开任何真实会话、不碰豆包——`issue/ws/pr/issue/outbox/clean/tasks` 照常工作；派单/投递「成功」但无人干活，inbox 只记账会堆积。
- **tracker 适配器**（当前 Gitea）：工单/PR 读写走适配器契约；`Issue.ref`（工单右侧分支）是 Gitea 特有能力位，换 GitHub/Jira 自动跳过。

## 一条龙工作流（noop/ZCode 承担全部智能工作）

```bash
foreman issue create --repo R --title <标题> [--body <正文>] [--ws]
# → tracker 建单 + 账本建档 planned；--ws 立即开工单所在仓的工作区

foreman ws add --repo <工程|owner/name> --issue <owner/name>#<N> [--base <基线>]
# → 从 origin/<base> 建 fix/issue-N + worktree（herdr/git 幂等，复用已有）
# → 账本没建档时回查 tracker 自举成 planned（所以跳过第 1 步也能直接 ws add）
# → 工单所在仓的工作区建好后，把分支写进工单右侧 ref（幂等，值已对不重写）

foreman ws list --issue <owner/name>#<N>   # 这条单开了哪几个工程（没建档回空清单）
```

然后**执行者（ZCode 或真 agent）进 worktree 写码、commit**；跨工程工单对每个工程各 `ws add` 一次（一工程一工作区、各一条 `fix/issue-N`、各一条 PR）。

```bash
foreman pr open --repo R --head fix/issue-N --title <标题> --body <改动+测试自证> --issue <N>
# 跨工程加 --issue-repo <工单所在仓>，把 PR 记到同一张单的 prs[]

foreman pr merge <N> --repo R    # 验收后由人类/独立验收系统执行；幂等（每 PR 只合一次）
# → 该单所有工程的 PR 都合完才收口：工单 done → 关远端单 → 删 worktree/本地分支（noop archive 假成功）
# → 保护分支必须人工批准 + CI 通过；UI PR 仍须两名测试同学验收，不得绕过

foreman clean <owner/name>#<N>   # 幂等清尾；foreman clean --all 清所有终端态工单残留
```

辅助：`foreman issue comment|close|settle`（评论/关单/只修本地 done）、`foreman retry <仓库> <N>`（放回队列，纯本地）、`foreman tasks --json`（会话树只读）、`foreman status` / `inbox list`（只读）、`foreman send --type mail|lark`（外发，与 agent 无关）、`foreman doctor`（体检；`--start` 在 noop 下不碰豆包）。

## noop 下禁用 / 无意义

- **禁用**（要真 agent，noop 下假成功不干活）：`hand`、`run`、`pickup`、`route`、`decide`、`worker run`。
- **无意义**（产出只会投进 noop）：`watch *`、`pr poll`、`mail poll`。定时任务（pickup/prWatch/mail/router/dreaming/自定义）当前全部 off——没有自动扫描，挑单由人/ZCode 决定。
- 已删除的旧命令：`dispatch`、`resume`、`orch start`、`sessions`，遇到相关提示不要再引用。

## 约束与状态

- 分支基线写在配置 `repos[].base`，验收按 `origin/<base>..HEAD` 算；分支名 `fix/issue-N`，worktree 在 `~/.foreman/worktrees/<工程>/fix-issue-N`。
- 合并唯一入口 `foreman pr merge`；主智能体/编码智能体不合并。缺信息或验收未过就保留工作区，别硬清。
- 账本 `~/.foreman/state.json`：`issues[键]`（state/workspaces/prs/branchRef…）；工单态 `planned/working/done/pr-open/needs-human/blocked/escalated/reset`，终端态不会再被自动捞。
- 服务文件在 `~/.foreman/`（`service.port`/`foreman.pid`/`service.log`）；CLI 全程 HTTP（默认 127.0.0.1:7317）。`service.enabled: false` 可整体禁用自动拉起。

## 排障速查

| 现象 | 处理 |
| --- | --- |
| `服务没起来` / ECONNREFUSED | 看 `~/.foreman/config.json` 的 `service.enabled`；确需服务就 `foreman serve`（noop 下安全） |
| `配置里没有这个工程` | `ws add` 的 `--repo` 要在配置 `repos[]` 里（`repo` 全名或 `name` 短名） |
| `账本里没有这条单，回查工单也失败` | 工单号写错或 tracker 上不存在；核对 `<owner/name>#<N>` |
| `workspace-failed` | 看 herdr 是否在跑（`herdr status`；不在会退回 `git worktree add`）；仓库 `origin/<base>` 是否存在 |
| clean 说 worktree 保留 | 里面有未提交改动——进 worktree 确认 commit 后重跑 |
| 合并不发生 | 对抗审查未过 / 等最终验收 / UI 验收人数不足；由人类执行 `pr merge`，失败会回理由（`mergeNote`） |
