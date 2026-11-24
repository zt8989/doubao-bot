---
name: foreman
description: 交付一条龙 CLI（doubao-bot/foreman）：工单交付工作流——建单、开工作区与分支（自动回写工单关联分支）、建 PR、验收后幂等合并并关单清尾。用户提到建工单、开工单分支、worktree、建 PR、合并 PR 关单、接单派单、foreman/工单/worktree 报错时使用。
---

# foreman：工单交付工作流

一条工单从建单到关单全程走 foreman CLI，动作进账本（`~/.foreman/state.json`）。

## 一条龙工作流

```bash
# 1. 建单（单已存在就跳过）
foreman issue create --repo R --title <标题> [--body <正文>] [--ws]
# → tracker 建单 + 账本建档 planned；--ws 顺带开工单所在仓的工作区

# 2. 建工作区（一工程一工作区；跨工程单逐工程各来一次）
foreman ws add --repo <工程|owner/name> --issue <owner/name>#<N> [--base <基线>]
# → 从 origin/<base> 建 fix/issue-N + worktree（~/.foreman/worktrees/<工程>/fix-issue-N，幂等，复用已有）
# → 建/复用后自动跑 repos[].worktreeHook（装依赖等，失败不阻塞；结果记账）
# → 账本没建档时回查 tracker 自举成 planned（所以跳过第 1 步也能直接 ws add）
# → 分支写进工单右侧 ref（幂等，值已对不重写）

foreman ws list --issue <owner/name>#<N>   # 这条单开了哪几个工程（没建档回空清单）
```

3. 执行者（人或接入的 agent）进 worktree 写码、commit。

```bash
# 4. 交 PR
foreman pr open --repo R --head fix/issue-N --title <标题> --body <改动+测试自证> --issue <N>
# 跨工程加 --issue-repo <工单所在仓>，把 PR 记到同一张单的 prs[]

# 5. 验收后合并（唯一合并入口，幂等，每 PR 只合一次）
foreman pr merge <N> --repo R
# → 该单所有工程的 PR 都合完才收口：工单 done → 关远端单 → 删 worktree/本地分支

# 6. 清尾（PR 全合并后）
foreman clean <owner/name>#<N>   # 关单+清尾：要求该单 PR 已全合并（先合完再 clean）；--all 清所有终端态残留
```

## 工作流规则

- 基线写在配置 `repos[].base`（`products[]` 配了就以它摊平为准），验收按 `origin/<base>..HEAD` 算；分支名固定 `fix/issue-N`。
- 工单态：`planned/working/pr-open/done/needs-human/blocked/escalated/reset`；终端态不会再被自动捞。
- `--repo` 认配置 `repos[]` 里的全名或短名；没配的仓库先加配置再操作。
- 合并保护：保护分支必须人工批准 + CI 通过；UI PR 必须两名测试同学验收，不得绕过。
- 缺信息或验收未过就保留工作区，别硬清；clean 遇未提交改动会保留 worktree，commit 后重跑。

辅助：`foreman issue comment|close|settle`（评论/关单/只修本地 done，settle 必带 `--note`）、`foreman retry <仓库> <N>`（放回队列，纯本地）、`foreman status` / `inbox list` / `tasks --json` / `doctor`（只读）。
