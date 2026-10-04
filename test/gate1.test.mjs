import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { fixture } from './fixtures.mjs';
import { configDigest, parseConfig } from '../src/config.mjs';

const at = timestamp => ({ clock: () => new Date(timestamp) });
const october30 = '2026-10-30T12:00:00.000Z';
const october31 = '2026-10-31T12:00:00.000Z';
const november1 = '2026-11-01T12:00:00.000Z';
const updateEvent = () => ({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'writer' } } });
const publishEvent = number => ({ action: 'closed', pull_request: { number, merged: true } });

test('configured PAT and App identities survive prepare/update/publish and every retry', async t => {
  for (const releaseAuthor of ['release-maintainer', 'release-app[bot]']) {
    await t.test(releaseAuthor, async child => {
      const f = await fixture(child, {}, { releaseAuthor });
      const failOnce = (endpoint, method, message) => {
        let failed = false;
        return async (executable, args, options) => {
          if (!failed && executable === 'gh' && args[1] === endpoint && args.includes(method)) { failed = true; throw new Error(message); }
          return f.runner(executable, args, options);
        };
      };
      await assert.rejects(f.engine({ runner: failOnce('repos/owner/project/pulls', 'POST', 'Simulated custom-author PR creation failure') }).prepare(), /Simulated custom-author PR creation failure/);
      const prepared = await f.engine().prepare();
      assert.equal(f.prs.get(1).user.login, releaseAuthor);
      assert.deepEqual(await f.engine().prepare(), prepared);
      const source = await f.advance();
      await f.event(updateEvent());
      await assert.rejects(f.engine({ runner: failOnce('repos/owner/project/pulls/1', 'PATCH', 'Simulated custom-author PR refresh failure') }).update(), /Simulated custom-author PR refresh failure/);
      const updated = await f.engine().update();
      assert.equal(updated['source-sha'], source);
      assert.deepEqual(await f.engine().update(), updated);
      await f.merge();
      await assert.rejects(f.engine({ runner: failOnce('repos/owner/project/releases', 'POST', 'Simulated custom-author release creation failure') }).publish(), /Simulated custom-author release creation failure/);
      const published = await f.engine().publish();
      assert.deepEqual(await f.engine().publish(), published);
      assert.equal(f.releases.size, 1);
      assert.equal(f.prs.get(1).user.login, releaseAuthor);
    });
  }
});

test('wrong exact PR author blocks prepare/update/publish before any engine mutation', async t => {
  const f = await fixture(t, {}, { releaseAuthor: 'trusted-release[bot]' });
  await f.engine().prepare();
  f.prs.get(1).user.login = 'different-app[bot]';
  f.mutations.length = 0;
  await assert.rejects(f.engine().prepare(), /must be authored by trusted-release\[bot\]/);
  assert.deepEqual(f.mutations, []);
  await f.event(updateEvent());
  await assert.rejects(f.engine().update(), /must be authored by trusted-release\[bot\]/);
  assert.deepEqual(f.mutations, []);
  await f.merge();
  await assert.rejects(f.engine().publish(), /must be authored by trusted-release\[bot\]/);
  assert.deepEqual(f.mutations, []);
});

test('new PR response must identify the configured token author and correct repository', async t => {
  const f = await fixture(t, {}, { releaseAuthor: 'expected-maintainer', tokenAuthor: 'wrong-maintainer' });
  await assert.rejects(f.engine().prepare(), /must be authored by expected-maintainer; verify the token identity/);
  assert.equal(f.prs.size, 1);
  assert.equal(f.releases.size, 0);
  const fork = await fixture(t);
  const runner = async (executable, args, options) => {
    const result = await fork.runner(executable, args, options);
    if (executable === 'gh' && args[1] === 'repos/owner/project/pulls' && args.includes('POST')) {
      const response = JSON.parse(result);
      response.head.repo.full_name = 'attacker/project';
      return JSON.stringify(response);
    }
    return result;
  };
  await assert.rejects(fork.engine({ runner }).prepare(), /Fork or cross-repository/);
});

test('PR-owned source config cannot authorize its own author outside trusted base history', async t => {
  const f = await fixture(t);
  await f.engine().prepare();
  const pr = f.prs.get(1);
  await f.git.scratch(pr.head.sha, async worktree => {
    const config = { ...f.config, releaseAuthor: 'attacker[bot]' };
    await writeFile(path.join(worktree.root, '.release.json'), JSON.stringify(config, null, 2) + '\n');
    await worktree.call(['add', '.release.json']);
    await worktree.call(['commit', '-m', 'chore: spoof release author']);
    const sourceSha = await worktree.sha('HEAD');
    const plan = JSON.parse(await readFile(path.join(worktree.root, '.datarose-release/release.json'), 'utf8'));
    plan.sourceSha = sourceSha;
    plan.configDigest = configDigest(parseConfig(JSON.stringify(config)));
    await writeFile(path.join(worktree.root, '.datarose-release/release.json'), JSON.stringify(plan, null, 2) + '\n');
    await worktree.call(['add', '.datarose-release/release.json']);
    await worktree.call(['commit', '-m', 'chore: spoof release state source']);
    await worktree.call(['push', 'origin', `HEAD:refs/heads/${pr.head.ref}`]);
  });
  pr.user.login = 'attacker[bot]';
  f.mutations.length = 0;
  await assert.rejects(f.engine().prepare(), /not in the trusted base branch history/);
  await f.event(updateEvent());
  await assert.rejects(f.engine().update(), /not in the trusted base branch history/);
  assert.deepEqual(f.mutations, []);
});

test('October CalVer plan initially publishes in November with immutable reviewed state and date', async t => {
  const f = await fixture(t);
  const prepared = await f.engine(at(october31)).prepare();
  const state = await f.git.file(f.prs.get(1).head.sha, '.datarose-release/release.json');
  const merged = await f.merge();
  const published = await f.engine(at(november1)).publish();
  assert.equal(published.version, '2026.10.1');
  assert.equal(published['source-sha'], prepared['source-sha']);
  assert.equal(published['release-sha'], merged);
  assert.equal(await f.git.file(merged, '.datarose-release/release.json'), state);
  assert.match(f.releases.get(published.tag).body, /2026-10-31/);
  assert.deepEqual(await f.engine(at(november1)).publish(), published);
});

test('successful remote tag followed by failed release create resumes across UTC month boundary', async t => {
  const f = await fixture(t, { draft: true, prerelease: true });
  const engineOptions = { ...at(october31), env: { RELEASE_VERSION: '2026.10.1' } };
  const prepared = await f.engine(engineOptions).prepare();
  assert.equal(prepared.version, '2026.10.1');
  const merged = await f.merge();
  const runner = async (executable, args, options) => {
    if (executable === 'gh' && args[1] === 'repos/owner/project/releases' && args.includes('POST')) throw new Error('Simulated October release creation failure');
    return f.runner(executable, args, options);
  };
  await assert.rejects(f.engine({ ...at(october31), runner }).publish(), /Simulated October release creation failure/);
  assert.equal(await f.git.remoteTag(prepared.tag), merged);
  assert.equal(f.releases.size, 0);
  const published = await f.engine(at(november1)).publish();
  const release = f.releases.get(published.tag);
  assert.equal(published.version, '2026.10.1');
  assert.equal(release.draft, true);
  assert.equal(release.prerelease, true);
  assert.match(release.body, /2026-10-31/);
  const mutations = f.mutations.length;
  assert.deepEqual(await f.engine(at(november1)).publish(), published);
  assert.equal(f.mutations.length, mutations);
});

test('historical replay after a newer valid release verifies recorded previous tag without duplicate writes', async t => {
  const f = await fixture(t);
  await f.engine(at(october30)).prepare();
  await f.merge(1);
  await f.engine(at(october30)).publish();
  await f.advance('code.txt', 'fix: October follow-up');
  await f.engine(at(october31)).prepare();
  const historicalMerge = await f.merge(2);
  const historical = await f.engine(at(october31)).publish();
  const historicalState = await f.git.file(historicalMerge, '.datarose-release/release.json');
  assert.equal(JSON.parse(historicalState).previousTag, 'v2026.10.1');
  await f.advance('code.txt', 'feat: November feature');
  const newerPlan = await f.engine(at(november1)).prepare();
  assert.equal(newerPlan.version, '2026.11.1');
  const newerMerge = await f.merge(3);
  const newer = await f.engine(at(november1)).publish();
  f.mutations.length = 0;
  await f.event(publishEvent(2));
  assert.deepEqual(await f.engine(at(november1)).publish(), historical);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.releases.size, 3);
  assert.equal(await f.git.remoteTag(newer.tag), newerMerge);
  assert.equal(await f.git.remoteTag(historical.tag), historicalMerge);
  assert.equal(await f.git.file(historicalMerge, '.datarose-release/release.json'), historicalState);
  const runner = async (executable, args, options) => {
    if (executable === 'git' && args.includes('ls-remote') && args.includes('refs/tags/v2026.10.1')) return `${newerMerge}\trefs/tags/v2026.10.1\n`;
    return f.runner(executable, args, options);
  };
  await assert.rejects(f.engine({ ...at(november1), runner }).publish(), /Recorded previous release tag no longer points to its expected commit/);
  assert.deepEqual(f.mutations, []);
});

test('matching local-only tag does not bypass stale unpublished snapshot checks', async t => {
  const f = await fixture(t);
  const prepared = await f.engine(at(october31)).prepare();
  const merged = await f.merge();
  await f.git.call(['tag', prepared.tag, merged]);
  assert.equal(await f.git.remoteTag(prepared.tag), null);
  await f.git.call(['tag', 'v2026.10.2', prepared['source-sha']]);
  await f.git.call(['push', 'origin', 'refs/tags/v2026.10.2']);
  f.mutations.length = 0;
  await assert.rejects(f.engine(at(november1)).publish(), /Release plan is stale/);
  assert.deepEqual(f.mutations, []);
  assert.equal(await f.git.remoteTag(prepared.tag), null);
  assert.equal(f.releases.size, 0);
});

test('CalVer refresh crossing month fails with prepare-new-PR guidance and no mutations', async t => {
  const f = await fixture(t);
  await f.engine(at(october31)).prepare();
  const oldHead = f.prs.get(1).head.sha;
  await f.advance();
  await f.event(updateEvent());
  f.mutations.length = 0;
  await assert.rejects(f.engine(at(november1)).update(), /prepare a new release PR instead of refreshing/);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.prs.get(1).head.sha, oldHead);
});

test('forced stable versions and draft-only automatic versions keep exact artifacts and API flags', async t => {
  for (const forced of [undefined, '2.0.0']) {
    await t.test(forced ? 'forced stable with draft and prerelease metadata' : 'automatic stable draft', async child => {
      const f = await fixture(child, { scheme: 'semver', draft: true, prerelease: Boolean(forced) });
      const options = forced ? { env: { RELEASE_VERSION: forced } } : {};
      const prepared = await f.engine(options).prepare();
      assert.equal(prepared.version, forced ?? '0.1.0');
      await f.event(updateEvent());
      assert.deepEqual(await f.engine().update(), prepared);
      await f.merge();
      const published = await f.engine().publish();
      const release = f.releases.get(published.tag);
      assert.equal(release.tag_name, `v${forced ?? '0.1.0'}`);
      assert.equal(release.draft, true);
      assert.equal(release.prerelease, Boolean(forced));
    });
  }
});

test('consumer src/test manifests update safely and symlinks remain rejected', async t => {
  for (const [directory, filename, format, original] of [['src', 'version.yaml', 'yaml', 'version: "0.0.0"'], ['test', 'version.json', 'json', '{"version":"0.0.0"}']]) {
    await t.test(directory, async child => {
      const file = `${directory}/${filename}`;
      const f = await fixture(child, { paths: [directory], changelog: false, manifests: [{ path: file, format, key: ['version'] }] });
      await f.advance(file, original);
      const prepared = await f.engine().prepare();
      assert.match(await f.git.file(f.prs.get(1).head.sha, file), new RegExp(prepared.version.replaceAll('.', '\\.')));
      await unlink(path.join(f.target, file));
      await symlink('../code.txt', path.join(f.target, file));
      await f.git.call(['add', file]);
      await f.git.call(['commit', '-m', 'test: unsafe symlink']);
      await f.git.call(['push', 'origin', 'master']);
      f.mutations.length = 0;
      await assert.rejects(f.engine().prepare(), /Symlinks are not supported/);
      assert.deepEqual(f.mutations, []);
    });
  }
});
