# gitea 命令参考（23 条，站点 106.54.199.229:3000，REST API）

`*` = 必填。输出统一为 `{ok:true,data}` / `{ok:false,error:{code,message}}`（JSON）。
旧的 `-f/--format`、`--window`、`--site-session`、`--keep-tab` 仍接受但忽略。

## 读

| 命令 | 说明 | 关键参数 |
|---|---|---|
| `pr-view <pr>` | PR 状态、正文、`mergeNote`、改动文件 | `--repo*`、`--files` |
| `pull-list` | 列仓库 PR（带回 `author`/`base`/`head`） | `--repo*`、`--state open\|closed\|all`、`--page` |
| `issue-view <issue>` | 工单正文 + 评论 | `--repo*` |
| `search <query>` | 搜索/列出工单 | `--repo*`、`--state open\|closed\|all`、`--label <id>`、`--assignee none\|any\|<user>`、`--milestone`、`--page` |
| `label-list` | 列标签（仓库级 + 组织级） | `--repo` 或 `--org` |
| `milestone <query>` | 列里程碑 | `--repo*`、`--state`、`--page` |
| `explore <kind> [query]` | 跨仓库聚合页 | `--state`、`--page`；kind = issues / pulls / milestones / repos |

## 写：工单

| 命令 | 说明 | 关键参数 |
|---|---|---|
| `issue` | 建单 | `--repo*`、`--title*`、`--body`、`--label`（名字或 id，逗号分隔）、`--assignee`、`--milestone`、`--due`、`--ref`、`--image` |
| `issue-comment <n> <body>` | 评论 | `--repo*` |
| `issue-edit <n>` | 改标题/正文/标签 | `--title`、`--body`、`--append`、`--label-add`、`--label-remove`、`--set-labels`、`--repo*` |
| `close <n>` / `reopen <n>` | 关闭 / 重开（PR 共用编号，同样有效） | `--repo*` |
| `assign <n> <user>` | 指派 | `--remove` 取消、`--repo*` |
| `due <n> <date>` | 截止日 | `--repo*` |
| `milestone-set <n> [ms]` | 设/清里程碑（工单与 PR 均可） | `--remove`、`--repo*` |
| `branch <issue> [name]` | 按单建分支 `issue-{n}-{slug}` | `--repo*`、`--base` |

## 写：PR

| 命令 | 说明 | 关键参数 |
|---|---|---|
| `pr` | 建 PR | `--repo*`、`--base*`、`--head*`、`--title*`、`--body`、`--draft`、`--label`、`--assignee`、`--milestone`、`--reviewer`、`--image` |
| `pr-edit <pr>` | 改标题/正文 | `--title`、`--body`、`--append`、`--repo*` |
| `pr-merge <pr>` | 合并 | `--style merge\|rebase\|rebase-merge\|squash\|fast-forward-only`、`--title`、`--message`、`--delete-branch`、`--force`、`--repo*` |

## 写：标签与里程碑

| 命令 | 说明 | 关键参数 |
|---|---|---|
| `label-create <name>` | 建标签 | `--color`、`--description`、`--repo` / `--org` |
| `milestone-create <title>` | 建里程碑 | `--due`、`--description`、`--repo*` |
| `milestone-close <ms>` | 关闭/重开里程碑 | `--reopen`、`--repo*` |
| `milestone-delete <ms>` | 删里程碑（单据上的标记一并清除） | `--repo*` |

## 输出字段（摘）

- `pr-view`：`number, title, head, base, state, merged, mergeable, mergeNote, commits, filesCount, createdAt, comments, bodyMd, url`
- `issue-view`：`number, title, state, labels, labelObjects, assignees, milestone, dueDate, bodyMd, comments, url`
- `close` / `reopen`：`issueNumber, state, url`（已是目标状态时报 `empty_result`）
- `issue-comment`：`issueNumber, commentId, url`
- `pr-merge`：`prNumber, merged, state, style, url`（已合并报 `empty_result`）

## 鉴权与站点

- 令牌：`GITEA_TOKEN` → `GITEA_TOKEN_FILE` → `~/.foreman/gitea-token` → `~/.config/gitea/token`
- 站点：`GITEA_BASE_URL` → `~/.foreman/config.json` 的 `gitea.baseUrl` → 默认内网地址
- 401 统一归一为 `auth_required`，提示重新生成令牌。
