# opencli gitea 命令参考（22 条，站点 106.54.199.229:3000）

`*` = 必填。所有命令支持通用输出参数 `-f/--format json|table|plain|yaml|md|csv`（默认 json）。

## 读

| 命令 | 说明 | 关键参数 |
|---|---|---|
| `pr-view <pr>` | PR 状态、正文、`mergeNote`、`filesCount` | `--repo*`、`--files`（实测失败） |
| `issue-view <issue>` | 工单正文 + 评论 | `--repo*` |
| `search <query>` | 搜索/列出工单（PR 也在其中） | `--repo*`、`--state open\|closed\|all`、`--label <id>`、`--assignee none\|any\|<user>`、`--milestone`、`--page` |
| `label-list` | 列标签（取 id 用） | `--repo` 或 `--org` |
| `milestone <query>` | 列里程碑 | `--repo*`、`--state`、`--page` |
| `explore <kind> [query]` | 顶部导航聚合页，跨仓库 | `--state`、`--page`；kind = pull-requests / issues / milestones / repos |

## 写：工单

| 命令 | 说明 | 关键参数 |
|---|---|---|
| `issue` | 建单 | `--repo*`、`--title*`、`--body`、`--label`（逗号分隔）、`--assignee`、`--milestone`、`--project`、`--ref`、`--image` |
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
| `pr` | 建 PR | `--repo*`、`--base*`、`--head*`、`--title*`、`--body`、`--draft`、`--label`、`--assignee`、`--milestone`、`--reviewer`、`--project`、`--image` |
| `pr-edit <pr>` | 改标题/正文 | `--title`、`--body`、`--append`、`--repo*` |
| `pr-merge <pr>` | 合并 | `--style merge\|rebase\|squash`、`--title`、`--message`、`--delete-branch`、`--force`、`--repo*` |

## 写：标签与里程碑

| 命令 | 说明 | 关键参数 |
|---|---|---|
| `label-create <name>` | 建标签 | `--color`、`--description`、`--repo` / `--org` |
| `milestone-create <title>` | 建里程碑 | `--due`、`--description`、`--repo*` |
| `milestone-close <ms>` | 关闭/重开里程碑 | `--reopen`、`--repo*` |
| `milestone-delete <ms>` | 删里程碑（单据上的标记一并清除） | `--repo*` |

## 输出字段（摘）

- `pr-view`：`number, title, head, base, state, mergeNote, createdAt, commits, comments, bodyMd, url`
- `issue-view`：`number, title, state, labels, assignees, milestone, bodyMd, comments, url`
- `close` / `reopen`：`issueNumber, state, url`
- `issue-comment`：`issueNumber, commentId, url`
- `pr-merge`：`prNumber, merged, url`

## 浏览器参数

`--window foreground|background`、`--site-session ephemeral|persistent`、`--keep-tab true|false`。
默认即可；需要盯着看过程用 `--window foreground`。
