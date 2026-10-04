import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { fixture } from './fixtures.mjs';
import { prBody } from '../src/notes.mjs';

test('prepare pins source, writes reviewed state, and retries without another commit', async t => {
  const f = await fixture(t);
  const source = await f.git.sha('HEAD');
  const result = await f.engine().prepare();
  assert.equal(result.version, '2026.10.1');
  assert.equal(result['source-sha'], source);
  assert.equal(result['pr-number'], '1');
  const pr = f.prs.get(1);
  const head = pr.head.sha;
  assert.equal(pr.head.ref, 'chore/datarose-release-automatization-for-v2026.10.1');
  const plan = JSON.parse(await f.git.file(head, '.datarose-release/release.json'));
  assert.equal(pr.body, prBody(plan));
  assert.match(await f.git.file(head, 'CHANGELOG.md'), /Reviewed source/);
  assert.deepEqual(await f.engine().prepare(), result);
  assert.equal(f.prs.get(1).head.sha, head);
  assert.equal(await f.git.sha('HEAD'), source);
  assert.equal((await f.git.call(['status', '--porcelain'])).trim(), '');
});

test('exact authorized comment refreshes version, advances source, adds a commit, and is idempotent', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  const oldHead = f.prs.get(1).head.sha;
  const source = await f.advance();
  await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'writer' } } });
  const result = await f.engine().update();
  assert.equal(result['source-sha'], source);
  assert.equal(result.version, '2026.10.1');
  const newHead = f.prs.get(1).head.sha;
  assert.notEqual(newHead, oldHead);
  assert.equal(await f.git.ancestor(oldHead, newHead), true);
  assert.equal(await f.git.ancestor(source, newHead), true);
  assert.deepEqual(await f.engine().update(), result);
  assert.equal(f.prs.get(1).head.sha, newHead);
});

test('comment injection, edited comments, non-PR comments, and unrelated merged PRs skip', async t => {
  const f = await fixture(t);
  for (const body of ['@datarose-release update; echo evil', '@datarose-release update\n', ' @datarose-release update']) {
    await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body, user: { login: 'writer' } } });
    assert.deepEqual(await f.engine().update(), {});
  }
  await f.event({ action: 'edited', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update' } });
  assert.deepEqual(await f.engine().update(), {});
  assert.equal(f.calls.length, 0);
});

test('read-only commenter and fork spoof cannot update a managed PR', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'reader' } } });
  f.setPermission('read');
  await assert.rejects(f.engine().update(), /Only collaborators/);
  f.setPermission('admin');
  f.prs.get(1).head.repo.full_name = 'attacker/project';
  await assert.rejects(f.engine().update(), /Fork or cross-repository/);
});

test('publish tags merged commit, uses exact reviewed notes, and resumes without duplicates', async t => {
  const f = await fixture(t);
  const prepared = await f.engine().prepare();
  const merged = await f.merge();
  const result = await f.engine().publish();
  assert.equal(result['source-sha'], prepared['source-sha']);
  assert.equal(result['release-sha'], merged);
  assert.notEqual(result['source-sha'], result['release-sha']);
  assert.equal(await f.git.sha('refs/tags/v2026.10.1'), merged);
  const plan = JSON.parse(await f.git.file(merged, '.datarose-release/release.json'));
  assert.equal(f.releases.get('v2026.10.1').body, plan.notes);
  assert.deepEqual(await f.engine().publish(), result);
  assert.equal(f.releases.size, 1);
  assert.equal(f.calls.filter(call => call.args[1] === 'repos/owner/project/releases' && call.input).length, 1);
});

test('publish accepts GitHub Release target_commitish metadata that differs from verified tag target', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  const merged = await f.merge();
  const plan = JSON.parse(await f.git.file(merged, '.datarose-release/release.json'));
  const runner = async (executable, args, options) => {
    const response = await f.runner(executable, args, options);
    if (executable !== 'gh' || args[1] !== 'repos/owner/project/releases' || !args.includes('POST')) return response;

    assert.equal(await f.git.sha(`refs/tags/${plan.tag}`), merged);
    assert.equal(await f.git.remoteTag(plan.tag), merged);
    const release = f.releases.get(plan.tag);
    release.target_commitish = 'master';
    return JSON.stringify(release);
  };

  const result = await f.engine({ runner }).publish();
  const release = f.releases.get(plan.tag);
  assert.equal(release.tag_name, plan.tag);
  assert.equal(release.body, plan.notes);
  assert.equal(release.draft, plan.draft);
  assert.equal(release.prerelease, plan.prerelease);
  assert.equal(release.target_commitish, 'master');
  assert.equal(result['release-id'], '100');
  assert.equal(result['release-url'], `https://github.com/owner/project/releases/tag/${plan.tag}`);
  assert.equal(await f.git.sha(`refs/tags/${plan.tag}`), merged);
  assert.equal(await f.git.remoteTag(plan.tag), merged);
});

test('squash merge works; tag-only mode omits GitHub Release outputs', async t => {
  const f = await fixture(t, { githubRelease: false, changelog: false });
  await f.engine().prepare();
  const merged = await f.merge(1, true);
  const result = await f.engine().publish();
  assert.equal(result['release-sha'], merged);
  assert.equal(result['release-id'], undefined);
  assert.equal(f.releases.size, 0);
  assert.equal(await f.git.file(merged, 'CHANGELOG.md', { missing: true }), null);
});

test('wrong existing tag fails instead of mutating', async t => {
  const f = await fixture(t);
  const source = await f.git.sha('HEAD');
  await f.engine().prepare();
  await f.merge();
  await f.git.call(['tag', 'v2026.10.1', source]);
  await f.git.call(['push', 'origin', 'refs/tags/v2026.10.1']);
  await assert.rejects(f.engine().publish(), /different commit/);
  assert.equal(f.releases.size, 0);
});

test('publish rejects base advancement after snapshot', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  await f.advance('other.txt', 'fix: unreviewed source');
  await f.merge();
  await assert.rejects(f.engine().publish(), /Base advanced|outside the generated allowlist/);
  assert.equal(f.releases.size, 0);
});

test('publish rejects edited PR notes, mismatched release flags and a newer previous tag', async t => {
  const f = await fixture(t, { draft: true, prerelease: true });
  await f.engine().prepare();
  const pr = f.prs.get(1);
  const originalBody = pr.body;
  await f.merge();
  pr.body += 'Unreviewed extra notes\n';
  await assert.rejects(f.engine().publish(), /body differs/);
  pr.body = originalBody;
  const published = await f.engine().publish();
  assert.equal(published.version, '2026.10.1-rc.1');
  const release = f.releases.get(published.tag);
  assert.equal(release.draft, true);
  assert.equal(release.prerelease, true);
  release.prerelease = false;
  await assert.rejects(f.engine().publish(), /Existing GitHub Release differs/);
});

test('publication resumes a tag-push failure and a release-create failure', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  await f.merge();
  let failedPush = false;
  const runner = async (executable, args, options) => {
    if (!failedPush && executable === 'git' && args.includes('push') && args.some(value => value.startsWith('refs/tags/'))) { failedPush = true; throw new Error('Simulated tag push failure'); }
    return f.runner(executable, args, options);
  };
  await assert.rejects(f.engine({ runner }).publish(), /Simulated tag push/);
  assert.equal(await f.git.remoteTag('v2026.10.1'), null);
  let failedCreate = false;
  const runner2 = async (executable, args, options) => {
    if (!failedCreate && executable === 'gh' && args[1] === 'repos/owner/project/releases' && args.includes('POST')) { failedCreate = true; throw new Error('Simulated release create failure'); }
    return f.runner(executable, args, options);
  };
  await assert.rejects(f.engine({ runner: runner2 }).publish(), /Simulated release create/);
  assert.equal(await f.git.remoteTag('v2026.10.1'), await f.git.sha('HEAD'));
  const result = await f.engine().publish();
  assert.equal(result['release-id'], '100');
  assert.equal(f.releases.size, 1);
});

test('a partial prepare resumes its recognizable initial branch without overwriting it', async t => {
  const f = await fixture(t);
  let failed = false;
  const runner = async (executable, args, options) => {
    if (!failed && executable === 'gh' && args[1] === 'repos/owner/project/pulls' && args.includes('POST')) { failed = true; throw new Error('Simulated PR create failure'); }
    return f.runner(executable, args, options);
  };
  await assert.rejects(f.engine({ runner }).prepare(), /Simulated PR create/);
  const result = await f.engine().prepare();
  assert.equal(result['pr-number'], '1');
});

test('source advance after update still publishes the reviewed refreshed merge', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  const source = await f.advance();
  await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'writer' } } });
  await f.engine().update();
  const merged = await f.merge();
  const result = await f.engine().publish();
  assert.equal(result['source-sha'], source);
  assert.equal(result['release-sha'], merged);
});

test('stale plan rejects a new previous release tag before updating branch', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  const source = await f.git.sha('HEAD');
  await f.git.call(['tag', 'v2026.10.2', source]);
  await f.git.call(['push', 'origin', 'refs/tags/v2026.10.2']);
  await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'writer' } } });
  await assert.rejects(f.engine().update(), /plan is stale/);
});

test('managed head with extra source edits fails the generated file allowlist', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  const pr = f.prs.get(1);
  await f.git.scratch(pr.head.sha, async worktree => {
    await writeFile(path.join(worktree.root, 'code.txt'), 'unreviewed alteration\n');
    await worktree.call(['add', 'code.txt']);
    await worktree.call(['commit', '-m', 'fix: hidden change']);
    await worktree.call(['push', 'origin', `HEAD:refs/heads/${pr.head.ref}`]);
  });
  await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'writer' } } });
  await assert.rejects(f.engine().update(), /outside the generated allowlist/);
});

test('clean-check protects unrelated local changes, and check makes no GitHub calls', async t => {
  const f = await fixture(t);
  const result = await f.engine().check();
  assert.equal(result.version, '2026.10.1');
  assert.equal(f.calls.length, 0);
  await writeFile(path.join(f.target, 'local.txt'), 'do not overwrite\n');
  await assert.rejects(f.engine().prepare(), /must be clean/);
  assert.equal(await readFile(path.join(f.target, 'local.txt'), 'utf8'), 'do not overwrite\n');
});

test('empty release requires an explicit forced version', async t => {
  const f = await fixture(t);
  const source = await f.git.sha('HEAD');
  await f.git.call(['tag', 'v2026.10.1', source]);
  await f.git.call(['push', 'origin', 'refs/tags/v2026.10.1']);
  await assert.rejects(f.engine().prepare(), /No relevant source changes/);
  const forced = f.engine({ env: { ...f.env, RELEASE_VERSION: '2026.10.2' } });
  const result = await forced.prepare();
  assert.equal(result.version, '2026.10.2');
  assert.match(f.prs.get(1).body, /No source changes \(explicit forced release\)/);
});
