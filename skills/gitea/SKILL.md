---
name: gitea
description: 通过 REST API 操作内网 Gitea（http://106.54.199.229:3000，仓库 yyzl/win-ai-harness）。当用户给出该域名下的任意链接（/pulls/N、/issues/N、/src/…、仓库首页）、或提到 win-ai-harness 的工单/PR 编号、或要求建单、看单、评论、打标签、指派、合并/关闭 PR 时使用。看到 106.54.199.229:3000 的链接即直接执行对应命令，不要反问用户，也不要用 web_fetch 抓页面（私有库匿名访问会返回 404）。它只负责读写，接单编排见 foreman。
---

# Gitea（内网 106.54.199.229:3000）

用 REST API，令牌放在 `~/.foreman/gitea-token`。统一走包装脚本 `scripts/gitea.sh`
（已处理 PATH 并直接透传 JSON）：

```bash
bash "$SKILL_DIR/scripts/gitea.sh" pr-view 217 --repo yyzl/win-ai-harness
```

命令实现在仓库 `gitea/` 包（CLI 入口 `gitea/bin/gitea.mjs`），foreman 与 opencli 的 gitea 适配器
都直接复用同一份 `gitea/src/api.mjs`（opencli 侧是 REST，不再是浏览器自动化）。单次调用是秒级，
不用后台跑、不用等 20–40s。

## 令牌

优先级：`GITEA_TOKEN` → `GITEA_TOKEN_FILE` → `~/.foreman/gitea-token` → `~/.config/gitea/token`。
站点地址：`GITEA_BASE_URL` → `~/.foreman/config.json` 的 `gitea.baseUrl` → 默认内网地址。

生成：Gitea「设置 → 应用 → 管理 Access Token」，至少勾 issue / repository / organization 的读写，
令牌只显示一次，写入文件后 `chmod 600`。令牌失效时接口返回 `auth_required`，重新生成即可，不要反复重试。

## URL → 命令路由

| 用户给的东西 | 动作 |
|---|---|
| `…/pulls/N` | `pr-view N --repo <owner/name>`；问「为什么不能合并」先读 `mergeNote` |
| `…/issues/N` | `issue-view N --repo <owner/name>` |
| `…/pulls` / `…/issues`（列表页） | `search "" --repo <owner/name> --state open` 或 `explore pulls` |
| `…/src/branch/<name>`、commit 链接 | 归 git：`git log` / `git diff`，不走 gitea |
| 只给编号、没给仓库 | 取 foreman 配置 `repos[]` 里的仓库；不确定就问 |

`<owner/name>` 取 URL 路径第 1、2 段。**`--repo` 必填**，漏了直接报错。

## 命令速查

```bash
# 读
pr-view <pr> --repo R [--files]  # 状态/正文/mergeNote/改动文件
pull-list --repo R --state open  # 列仓库 PR（带回 author、base、head）
issue-view <issue> --repo R
search "关键词" --repo R --state open --label <id>
label-list --repo R              # 仓库级 + 组织级标签；查名→id
milestone "" --repo R
explore issues|pulls|milestones|repos

# 写（用户明确要求才执行）
issue --repo R --title "标题" --body "md" --label needs-triage
issue-comment <n> "md" --repo R
issue-edit <n> --repo R --title/--body/--append/--label-add/--label-remove/--set-labels
close <n> --repo R ; reopen <n> --repo R        # 工单与 PR 共用编号，对 PR 一样有效
pr --repo R --base <目标> --head <源> --title "标题" --body "md" [--draft]
pr-merge <pr> --repo R [--style merge|rebase|squash] [--delete-branch]
assign <n> <user> --repo R ; due <n> <date> --repo R ; milestone-set <n> <ms> --repo R
```

完整参数表（23 条命令）见 `references/commands.md`。

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

gitea 的写命令基本都能直接用，**只有两步必须交给 foreman**，因为它们要写账本、要幂等：

```bash
foreman pr open --repo R --head <分支> --title "…" --body "…" --issue N   # 建 PR，基线取配置 repos[].base
foreman pr merge <N> --repo R                                              # 合并：每张 PR 只合一次
```

- 直接 `gitea pr` 建的 PR 不会进账本，控制台看不到这条、也挂不上「单 + 会话」。
- 合并走 `foreman pr merge` 才有幂等（`mergeAsk`）与合完推进状态。

其余写——建单 `issue`、评论 `issue-comment`、改 `issue-edit`、`close`/`reopen`、`assign`/`due`/`milestone-set`——直接调就行，不用绕 foreman；代价只是这些动作不进 `~/.foreman/console.db`，工作流照走（下一轮 `search --label` 会读到最新值）。

## 执行注意

- **错误口径**：输出 `{ok:false,error:{code,message,status?}}`。`auth_required` 重生成令牌；
  `not_found` 看编号/仓库；`empty_result` 表示“已经是目标状态/无需重复操作”，不是故障。
- **标签 id vs 名字**：`search --label` 收 id（内部翻成名字再按 id 精确过滤）；`issue --label` /
  `issue-edit --label-add` 收名字或 id。组织级标签（`needs-triage` 等）会被 `label-list` 合并返回。
- **里程碑名可能全是数字**（`1105`、`1126`）：先按 id、再按名字匹配。
- **列表不带正文**：`search` / `pull-list` 只回收敛字段；正文用 `issue-view` / `pr-view`。
- **web_fetch 必 404**：私有库匿名访问一律 not found，不能用它判断链接是否失效。

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
