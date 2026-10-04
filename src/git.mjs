import path from 'node:path';
import { mkdtemp, rm, realpath, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { invariant } from './errors.mjs';
import { run } from './runner.mjs';
import { validRef } from './config.mjs';

export const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);

export class Git {
  constructor(root, runner = run, env = process.env) {
    this.root = root;
    this.runner = runner;
    this.env = { ...env, GIT_TERMINAL_PROMPT: '0' };
  }

  async call(args, options = {}) {
    return this.runner('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', ...args], { cwd: this.root, env: this.env, ...options });
  }

  async clean() {
    invariant(path.isAbsolute(this.root), 'RELEASE_REPOSITORY_DIR must be absolute.');
    invariant(await realpath(this.root) === (await this.call(['rev-parse', '--show-toplevel'])).trim(), 'Target must be the checkout root.');
    invariant((await this.call(['status', '--porcelain=v1', '--untracked-files=normal'])).trim() === '', 'Target checkout must be clean; commit or remove local changes before releasing.');
  }

  async sha(ref) {
    const sha = (await this.call(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    invariant(isSha(sha), `Invalid commit for ${ref}.`);
    return sha;
  }

  async file(ref, file, { missing = false } = {}) {
    const entry = (await this.call(['ls-tree', ref, '--', file])).trim();
    if (!entry && missing) return null;
    invariant(/^100(?:644|755) blob [0-9a-f]{40}\t/u.test(entry), `Missing, symlinked, or unsupported file: ${file}`);
    return this.call(['show', `${ref}:${file}`]);
  }

  async ancestor(older, newer) {
    try { await this.call(['merge-base', '--is-ancestor', older, newer]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  }

  async tags() {
    return (await this.call(['tag', '--list'])).trim().split('\n').filter(Boolean);
  }

  async remoteBranch(branch) {
    invariant(validRef(branch), 'Invalid managed branch ref.');
    const result = (await this.call(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).trim();
    if (!result) return null;
    const [sha, ref] = result.split(/\s+/u);
    invariant(isSha(sha) && ref === `refs/heads/${branch}`, 'Remote branch lookup returned an unexpected ref.');
    await this.call(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
    return sha;
  }

  async fetchBase(branch) {
    invariant(validRef(branch), 'Invalid base branch ref.');
    await this.call(['fetch', '--tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return this.sha(`refs/remotes/origin/${branch}`);
  }

  async remoteTag(tag) {
    invariant(validRef(tag), 'Invalid release tag ref.');
    const lines = (await this.call(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])).trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    const entries = lines.map(line => line.split(/\s+/u));
    invariant(entries.every(([sha, ref]) => isSha(sha) && [ `refs/tags/${tag}`, `refs/tags/${tag}^{}` ].includes(ref)), 'Remote tag lookup returned an unexpected ref.');
    return (entries.find(([, ref]) => ref.endsWith('^{}')) ?? entries[0])[0];
  }

  async scratch(sha, action) {
    let base = this.env.RUNNER_TEMP;
    if (!base) { try { await access('/tmp/opencode'); base = '/tmp/opencode'; } catch { base = tmpdir(); } }
    const temporary = await mkdtemp(path.join(base, 'datarose-release-'));
    const directory = path.join(temporary, 'checkout');
    let added = false;
    try {
      await this.call(['worktree', 'add', '--detach', directory, sha]);
      added = true;
      return await action(new Git(directory, this.runner, this.env));
    } finally {
      if (added) await this.call(['worktree', 'remove', '--force', directory]);
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async commit(changes, plan, previousHead) {
    await mkdir(path.join(this.root, '.datarose-release'), { recursive: true });
    await this.call(['add', '--', ...changes]);
    const tree = (await this.call(['write-tree'])).trim();
    const parents = previousHead && previousHead !== plan.sourceSha ? ['-p', previousHead, '-p', plan.sourceSha] : ['-p', plan.sourceSha];
    const message = `chore(release): ${plan.unit} ${plan.version}\n\nSource-SHA: ${plan.sourceSha}\n`;
    const env = {
      ...this.env, GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_AUTHOR_DATE: plan.releaseDate, GIT_COMMITTER_DATE: plan.releaseDate,
    };
    const sha = (await this.call(['commit-tree', tree, ...parents], { input: message, env })).trim();
    invariant(isSha(sha), 'Could not create a release commit.');
    return sha;
  }
}
