import path from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Git } from '../src/git.mjs';
import { run, CommandError } from '../src/runner.mjs';
import { ReleaseEngine } from '../src/engine.mjs';

export async function fixture(t, overrides = {}, { releaseAuthor, tokenAuthor = releaseAuthor ?? 'github-actions[bot]' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'release-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = path.join(root, 'origin.git');
  const target = path.join(root, 'target');
  const env = { ...process.env, RELEASE_REPOSITORY_DIR: target, RELEASE_CONFIG: '.release.json', GITHUB_REPOSITORY: 'owner/project', GH_TOKEN: 'test-private-token', GITHUB_EVENT_PATH: path.join(root, 'event.json') };
  await run('git', ['init', '--bare', '--initial-branch=master', bare]);
  await run('git', ['clone', bare, target]);
  const git = new Git(target);
  await git.call(['config', 'user.name', 'Test']);
  await git.call(['config', 'user.email', 'test@example.com']);
  const unit = { scheme: 'calver', paths: ['.'], tagPrefix: 'v', changelog: 'CHANGELOG.md', manifests: [{ path: 'package.json', format: 'json', key: ['version'] }], ...overrides };
  const config = { baseBranch: 'master', ...(releaseAuthor === undefined ? {} : { releaseAuthor }), units: { release: unit } };
  await writeFile(path.join(target, '.release.json'), JSON.stringify(config, null, 2) + '\n');
  await writeFile(path.join(target, 'package.json'), '{\n  "version": "0.0.0",\n  "scripts": {"postinstall": "never execute"}\n}\n');
  await writeFile(path.join(target, 'code.txt'), 'initial\n');
  await git.call(['add', '.']);
  await git.call(['commit', '-m', 'feat: initial implementation']);
  await git.call(['push', 'origin', 'master']);
  const repository = 'owner/project';
  const prs = new Map();
  const releases = new Map();
  const calls = [];
  const mutations = [];
  let permission = 'write';
  let nextPr = 1;
  let nextRelease = 100;
  const branchHead = async branch => (await run('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${branch}`])).trim();
  const refreshPr = async pr => {
    if (!pr.merged_at) pr.head.sha = await branchHead(pr.head.ref);
    await run('git', ['--git-dir', bare, 'update-ref', `refs/pull/${pr.number}/head`, pr.head.sha]);
    return pr;
  };
  const runner = async (executable, args, options) => {
    if (executable !== 'gh') {
      if (executable === 'git' && (args.includes('push') || args.includes('commit-tree') || (args.includes('tag') && !args.includes('--list')))) mutations.push({ executable, args });
      return run(executable, args, options);
    }
    calls.push({ executable, args, input: options.input });
    const [command, endpoint] = args;
    if (command !== 'api') throw new Error('Only gh api is expected.');
    const method = args[args.indexOf('--method') + 1];
    if (method !== 'GET') mutations.push({ executable, args });
    const body = options.input ? JSON.parse(options.input) : undefined;
    let response;
    if (endpoint === `repos/${repository}`) response = { default_branch: 'master' };
    else if (endpoint.includes('/collaborators/')) response = { permission };
    else if (endpoint.startsWith(`repos/${repository}/pulls?`)) {
      const query = new URL(`https://example.com/${endpoint}`).searchParams;
      const branch = query.get('head').slice('owner:'.length);
      response = await Promise.all([...prs.values()].filter(pr => pr.head.ref === branch && pr.base.ref === query.get('base')).map(refreshPr));
    } else if (endpoint === `repos/${repository}/pulls` && method === 'POST') {
      response = {
        number: nextPr++, state: 'open', merged_at: null, title: body.title, body: body.body,
        user: { login: tokenAuthor, type: tokenAuthor.endsWith('[bot]') ? 'Bot' : 'User' },
        html_url: `https://github.com/${repository}/pull/${nextPr - 1}`, merged: false, merge_commit_sha: null,
        head: { ref: body.head, sha: await branchHead(body.head), repo: { full_name: repository } },
        base: { ref: body.base, sha: await branchHead(body.base), repo: { full_name: repository } },
      };
      prs.set(response.number, response);
      await refreshPr(response);
    } else if (/\/pulls\/\d+$/u.test(endpoint)) {
      response = prs.get(Number(endpoint.split('/').at(-1)));
      if (body) Object.assign(response, body);
      await refreshPr(response);
    } else if (endpoint.startsWith(`repos/${repository}/releases/tags/`)) {
      const tag = decodeURIComponent(endpoint.split('/releases/tags/')[1]);
      response = releases.get(tag);
      if (!response) throw new CommandError('gh', 1, 'gh: Not Found (HTTP 404)', env);
    } else if (endpoint === `repos/${repository}/releases` && method === 'POST') {
      response = { ...body, id: nextRelease++, html_url: `https://github.com/${repository}/releases/tag/${body.tag_name}` };
      releases.set(body.tag_name, response);
    } else throw new Error(`Unexpected fake GitHub call: ${method} ${endpoint}`);
    return JSON.stringify(response);
  };
  const cliff = {
    bumped: async (_root, input, previous) => `${input.tagPrefix}${previous.version.split('.').slice(0, 2).join('.')}.${Number(previous.version.split('.')[2]) + 1}`,
    notes: async (_root, _unit, plan) => `## [${plan.version}] - ${plan.releaseDate.slice(0, 10)}\n\n- Reviewed source ${plan.sourceSha.slice(0, 7)}\n`,
  };
  const engine = (extra = {}) => new ReleaseEngine({ runner, clock: () => new Date('2026-10-03T12:00:00.000Z'), cliff, ...extra, env: { ...env, ...extra.env } });
  const event = async value => writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({ repository: { full_name: repository }, ...value }));
  const advance = async (filename = 'code.txt', message = 'fix: next change') => {
    await mkdir(path.dirname(path.join(target, filename)), { recursive: true });
    await writeFile(path.join(target, filename), `${message}\n`);
    await git.call(['add', '--', filename]);
    await git.call(['commit', '-m', message]);
    await git.call(['push', 'origin', 'master']);
    return git.sha('HEAD');
  };
  const merge = async (number = 1, squash = false) => {
    const pr = await refreshPr(prs.get(number));
    await git.call(['fetch', 'origin', pr.head.ref]);
    await git.call(['merge', squash ? '--squash' : '--no-ff', 'FETCH_HEAD', ...(squash ? [] : ['-m', pr.title])]);
    if (squash) await git.call(['commit', '-m', pr.title]);
    const sha = await git.sha('HEAD');
    await git.call(['push', 'origin', 'master']);
    pr.state = 'closed'; pr.merged = true; pr.merged_at = '2026-10-03T12:30:00Z'; pr.merge_commit_sha = sha;
    await event({ action: 'closed', pull_request: { number, merged: true } });
    return sha;
  };
  return { root, bare, target, env, git, config, runner, cliff, engine, prs, releases, calls, mutations, event, advance, merge, setPermission: value => { permission = value; } };
}
