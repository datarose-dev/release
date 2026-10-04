import { invariant } from './errors.mjs';
import { run } from './runner.mjs';
import { validLogin } from './config.mjs';

export function repositoryName(value) {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) && !value.split('/').some(part => part === '.' || part === '..'), 'GITHUB_REPOSITORY must be owner/repository.');
  return value;
}

export const isNotFound = error => /\bHTTP 404\b/u.test(error.stderr ?? '');

export class GitHub {
  constructor(repository, runner = run, env = process.env, cwd) {
    this.repository = repositoryName(repository);
    this.runner = runner;
    this.env = env;
    this.cwd = cwd;
  }

  async api(endpoint, { method = 'GET', body } = {}) {
    const args = ['api', endpoint, '--method', method];
    if (body !== undefined) args.push('--input', '-');
    const output = await this.runner('gh', args, { cwd: this.cwd, env: this.env, input: body === undefined ? undefined : JSON.stringify(body) });
    try { return JSON.parse(output); } catch { invariant(false, 'GitHub returned invalid JSON.'); }
  }

  async pr(number) {
    invariant(Number.isSafeInteger(number) && number > 0, 'Invalid pull request number.');
    return this.api(`repos/${this.repository}/pulls/${number}`);
  }

  async findPr(branch, base) {
    const owner = this.repository.split('/')[0];
    const prs = await this.api(`repos/${this.repository}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&state=all&per_page=100`);
    invariant(Array.isArray(prs) && prs.length < 100, 'Ambiguous release PR search; inspect repository pull requests.');
    invariant(prs.length <= 1, 'Multiple PRs use the managed release branch.');
    return prs[0] ?? null;
  }

  async permission(login) {
    invariant(typeof login === 'string' && /^[A-Za-z0-9-]+(?:\[bot\])?$/u.test(login), 'Invalid commenter login.');
    const result = await this.api(`repos/${this.repository}/collaborators/${encodeURIComponent(login)}/permission`);
    return result.permission;
  }

  async release(tag) {
    try { return await this.api(`repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`); }
    catch (error) { if (isNotFound(error)) return null; throw error; }
  }
}

export function managedPr(pr, { repository, branch, base, releaseAuthor, open = false, merged = false }) {
  invariant(validLogin(releaseAuthor), 'Expected release PR author must come from trusted releaseAuthor configuration.');
  invariant(pr && pr.user?.login === releaseAuthor, `Release PR must be authored by ${releaseAuthor}; verify the token identity and trusted releaseAuthor configuration.`);
  invariant(pr.head?.repo?.full_name === repository && pr.base?.repo?.full_name === repository, 'Fork or cross-repository release PRs are not supported.');
  invariant(pr.head.ref === branch && pr.base.ref === base, 'Release PR has an unexpected head or base branch.');
  if (open) invariant(pr.state === 'open' && !pr.merged_at, 'Release PR is not open.');
  if (merged) invariant(pr.state === 'closed' && pr.merged_at, 'Release PR is not merged.');
}
