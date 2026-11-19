// REST 版 gitea 适配器的公共层：错误口径、参数校验、站点地址。
// 业务实现都在仓库根的 gitea/src/api.mjs（与 gitea CLI、foreman 共用一份），
// 适配器只负责把 opencli 的命令协议（args / columns）接到这些函数上，不再驱动浏览器。
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@jackwener/opencli/errors';
import { GiteaApiError, loadGiteaSettings } from '../../gitea/src/client.mjs';
import { listMilestones } from '../../gitea/src/api.mjs';

export * from '../../gitea/src/api.mjs';

export const siteBase = () => loadGiteaSettings().baseUrl;

export const siteHost = () => {
  try {
    return new URL(siteBase()).host;
  } catch {
    return '';
  }
};

// 已经是 opencli 的 CliError：原样抛出，别把 code/exitCode 洗掉。
const CLI_ERROR_NAMES = new Set([
  'CliError',
  'ArgumentError',
  'AuthRequiredError',
  'CommandExecutionError',
  'ConfigError',
  'TimeoutError',
  'EmptyResultError',
  'SessionBusyError',
  'BrowserConnectError',
]);

function toCliError(label, error) {
  if (error && CLI_ERROR_NAMES.has(error.name)) return error;
  const message = String(error?.message ?? error);
  const code = String(error?.code ?? '');

  if (error instanceof GiteaApiError || code) {
    switch (code) {
      case 'argument_error':
        return new ArgumentError(message);
      case 'auth_required':
        return new AuthRequiredError(
          siteHost(),
          message,
          '令牌无效或缺失：在 Gitea「设置 → 应用 → 管理 Access Token」生成后写入 ~/.foreman/gitea-token（chmod 600），或设置 GITEA_TOKEN',
        );
      case 'empty_result':
        // 与旧适配器口径一致：已经做过/无需重复操作，退出码 66。
        return new EmptyResultError(`gitea ${label}`, message);
      case 'not_found':
      case 'conflict':
      default:
        return new CommandExecutionError(message);
    }
  }
  return new CommandExecutionError(`gitea ${label} 失败：${message}`);
}

// 非浏览器命令的 func 只收 (kwargs, debug)；所有 REST 异常在这里归一成 opencli 错误。
export const command = (label, fn) => async (args = {}, debug = false) => {
  try {
    return await fn(args ?? {}, Boolean(debug));
  } catch (error) {
    throw toCliError(label, error);
  }
};

export const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const requireRepo = (repo) => {
  const s = String(repo ?? '').replace(/^\/+|\/+$/g, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(s)) throw new ArgumentError(`repo 必须是 owner/name 格式，当前: "${repo}"`);
  return s;
};

export const requireInt = (value, label = '编号') => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ArgumentError(`${label}必须是正整数，当前: "${value}"`);
  return n;
};

export const pageOf = (value) => {
  const n = Number(value ?? 1) || 1;
  if (!Number.isInteger(n) || n <= 0) throw new ArgumentError(`page 必须是正整数，当前: "${value}"`);
  return n;
};

export async function resolveMilestoneId(repo, value) {
  const wanted = String(value ?? '').trim();
  if (!wanted) throw new ArgumentError('milestone 不能为空');
  const list = await listMilestones(repo, { state: 'all', all: true });
  const hit = list.find((m) => String(m.id) === wanted) ?? list.find((m) => m.name === wanted);
  if (!hit) {
    throw new CommandExecutionError(
      `找不到里程碑 "${wanted}"，可选: ${list.map((m) => `${m.name}=${m.id}`).join(', ') || '（仓库还没有里程碑）'}`,
    );
  }
  return hit.id;
}

export const milestoneUrl = (repo, id) => (id ? `${siteBase()}/${repo}/milestone/${id}` : '');
