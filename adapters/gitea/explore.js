// 顶部导航聚合页：所有工单 / 合并请求 / 里程碑 / 仓库（跨仓库，登录用户视角）——REST API。
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { command, listMilestones, listMyRepos, milestoneUrl, pageOf, searchIssuesAcross, searchRepos } from './rest.js';

const KINDS = ['issues', 'pulls', 'milestones', 'repos'];
const STATES = ['open', 'closed', 'all'];

cli({
  site: 'gitea',
  name: 'explore',
  description: '顶部导航聚合页：所有工单 / 合并请求 / 里程碑 / 仓库（跨仓库，登录用户视角，REST API）',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'kind', type: 'string', required: true, positional: true, choices: KINDS, help: '聚合类型: issues=工单, pulls=合并请求, milestones=里程碑, repos=仓库(探索)' },
    { name: 'query', type: 'string', positional: true, default: '', help: '关键词；repos 时命中仓库名/描述，issues/pulls 时命中标题' },
    { name: 'state', type: 'string', default: 'open', choices: STATES, help: '状态（repos 忽略）' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
  ],
  columns: ['kind', 'repo', 'number', 'title', 'state', 'url'],
  func: command('explore', async (args) => {
    const kind = String(args.kind ?? '').trim();
    if (!KINDS.includes(kind)) throw new ArgumentError(`kind 必须是 ${KINDS.join('/')}`);
    const query = String(args.query ?? '').trim();
    const state = String(args.state ?? 'open');
    const page = pageOf(args.page);

    if (kind === 'repos') {
      const list = await searchRepos(query, { page });
      return list.map((r) => ({ kind: 'repo', repo: r.repo, number: null, title: r.name, state: '', url: r.htmlUrl }));
    }
    if (kind === 'issues' || kind === 'pulls') {
      const list = await searchIssuesAcross({ q: query, state, type: kind === 'issues' ? 'issues' : 'pulls', page });
      return list.map((i) => ({
        kind: kind === 'issues' ? 'issue' : 'pull',
        repo: i.repo,
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.url,
      }));
    }

    const repos = await listMyRepos({ limit: 50 });
    const out = [];
    for (const r of repos) {
      try {
        const list = await listMilestones(r.repo, { state: state === 'all' ? 'all' : state, query, all: state === 'all' });
        for (const m of list) {
          if (query && !String(m.name).toLowerCase().includes(query.toLowerCase())) continue;
          out.push({ kind: 'milestone', repo: r.repo, number: m.id, title: m.name, state: m.state, url: milestoneUrl(r.repo, m.id) });
        }
      } catch {}
    }
    return out;
  }),
});
