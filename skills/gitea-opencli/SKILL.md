---
name: gitea-opencli
description: 通过 opencli 浏览器自动化操作内网 Gitea（http://106.54.199.229:3000，仓库 yyzl/win-ai-harness）。当用户给出该域名下的任意链接（/pulls/N、/issues/N、/src/…、仓库首页）、或提到 win-ai-harness 的工单/PR 编号、或要求建单、看单、评论、打标签、指派、合并/关闭 PR 时使用。看到 106.54.199.229:3000 的链接即直接执行对应命令，不要反问用户，也不要用 web_fetch/curl 抓页面（私有库会返回 404）。它只负责读写，接单编排见 foreman。
---

# Gitea（内网 106.54.199.229:3000）

opencli 复用 **Chrome 已登录会话**做页面自动化，无需 token。统一走包装脚本
`scripts/gitea.sh`（已处理 PATH 与 JSON 清洗）：

```bash
bash "$SKILL_DIR/scripts/gitea.sh" pr-view 217 --repo yyzl/win-ai-harness
```

适配器源码在 `~/Documents/workspace/doubao-bot/adapters/gitea`；`~/.opencli/clis/gitea` 是真目录，
里面每个 `.js` 都软链回仓库（opencli 的发现逻辑只认真目录，目录整体软链会让 gitea 命令整条消失）。
改适配器直接改仓库里的文件，`opencli` 下次调用立刻生效；新增/删除文件后跑一次
`bash ~/Documents/workspace/doubao-bot/scripts/link-adapter.sh` 补链。

## URL → 命令路由

| 用户给的东西 | 动作 |
|---|---|
| `…/pulls/N` | `pr-view N --repo <owner/name>`；问「为什么不能合并」先读 `mergeNote` |
| `…/issues/N` | `issue-view N --repo <owner/name>` |
| `…/pulls` / `…/issues`（列表页） | `search "" --repo <owner/name> --state open` 或 `explore pull-requests` |
| `…/src/branch/<name>`、commit 链接 | 归 git：`git log` / `git diff`，不走 gitea |
| 只给编号、没给仓库 | 取 foreman 配置 `repos[]` 里的仓库；不确定就问 |

`<owner/name>` 取 URL 路径第 1、2 段。**`--repo` 必填**，漏了直接报错。

## 命令速查

```bash
# 读
pr-view <pr> --repo R            # 状态/正文/mergeNote（--files 实测报"无法访问"，别用）
pull-list --repo R --state open  # 列仓库 PR，带回 author（列表页不回 base/head）
issue-view <issue> --repo R
search "关键词" --repo R --state open --label <id>
label-list --repo R              # search --label 只认 id，先查名→id
milestone "" --repo R
explore pull-requests|issues|milestones|repos

# 写（用户明确要求才执行）
issue --repo R --title "标题" --body "md" --label needs-triage
issue-comment <n> "md" --repo R
issue-edit <n> --repo R --title/--body/--append/--label-add/--label-remove/--set-labels
close <n> --repo R ; reopen <n> --repo R        # 工单与 PR 共用编号，对 PR 一样有效
pr --repo R --base <目标> --head <源> --title "标题" --body "md"
pr-merge <pr> --repo R [--style merge|rebase|squash] [--delete-branch]
assign <n> <user> --repo R ; due <n> <date> --repo R ; milestone-set <n> <ms> --repo R
```

完整参数表（23 条命令，含 positionals/options）见 `references/commands.md`。

## 判断「没什么可合并」

`pr-view` 的 `mergeNote` 会直说（例：*此分支已经包含在目标分支中，没有什么可以合并*）。
再用本地 git 交叉验证，别只看网页：

```bash
git merge-base --is-ancestor <head-sha> <base-branch> && echo "已包含 → 重复单"
git log --oneline <base>..<head>   # 空 = 0 提交
```

典型成因：**同一分支开了两次 PR**，先合的把提交带进目标分支，后开的自然无可合并。
处置：关闭重复单 + 评论写「重复于 #X，分支已由 #X 合入 <base>」。

## 写操作收口（只有两处）

opencli 的写命令基本都能直接用，**只有两步必须交给 foreman**，因为它们要写账本、要幂等：

```bash
foreman pr open --repo R --head <分支> --title "…" --body "…" --issue N   # 建 PR，基线取配置 repos[].base
foreman pr merge <N> --repo R                                              # 合并：每张 PR 只合一次
```

- 直接 `opencli gitea pr` 建的 PR 不会进账本，控制台看不到这条、也挂不上「单 + 会话」。
- 合并走 `foreman pr merge` 才有幂等（`mergeAsk`）与合完推进状态。

其余写——建单 `issue`、评论 `issue-comment`、改 `issue-edit`、`close`/`reopen`、`assign`/`due`/`milestone-set`——直接调就行，不用绕 foreman；代价只是这些动作不进 `~/.foreman/console.db`，工作流照走（下一轮 `search --label` 会读到最新值）。

## 执行注意

- **耗时**：每条 20–40s（要开浏览器）。用 `run_in_background: true` + `TaskOutput(block=true, timeout=120000)`，别用 15s 前台等待。
- **PATH**：Bash 非登录 shell 里 `opencli` 不在 PATH；`scripts/gitea.sh` 已内置
  `$HOME/.nvm/versions/node/v22.21.1/bin`，环境变了用 `OPENCLI_BIN_DIR` 覆盖。
- **输出噪声**：末尾常带 `Update available …`，直接 `json.loads` 会析构失败；脚本已截取首个 `{` 到末个 `}`。
- **登录态失效**：返回 401 或「请确认登录态有效」时，让用户在该 Chrome 登录 Gitea 后重试，不要反复重跑。
- **web_fetch / curl 必 404**：私有库匿名访问一律 not found，不能用它判断链接是否失效。

## 本仓约定（yyzl/win-ai-harness）

- 标题/正文中文；长设计放 `docs/`，工单只放链接与上下文。
- triage 标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
  `ready-for-agent` 只是「可以交给执行器」的标记，不代表已经有东西会自动接手；接单编排在 `foreman` 里。
- PR 正文按仓库模板：Summary、提交与范围、自证（测试结果）、Merge Danger、验收判据。
- 细则见仓库 `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`。

## 已知案例（2026-11-10）

PR #217（`fix/issue-210-env-secrets` → `sit-20261126`）显示无可合并：同分支的 #215 已合入 sit
（合并提交 `23e7cac`），head `66bef76` 已是基线祖先 → 关闭 #217 并留评论；前端「从 win-manager
导入」改动在本地分支 `feat/issue-210-mcp-import`（未推送），另行开单。
