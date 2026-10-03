import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/runner.mjs';
import { fixture } from './fixtures.mjs';
import { Cliff } from '../src/notes.mjs';

let available = false;
try { await run('git-cliff', ['--version']); available = true; } catch { /* Unit tests remain usable without the external binary. */ }
if (process.env.REQUIRE_GIT_CLIFF === '1') assert.ok(available, 'git-cliff must be available for mandatory real-binary tests.');

test('real git-cliff uses pinned config, deterministic dates and prefixed SemVer bumps', { skip: !available }, async t => {
  const f = await fixture(t, { scheme: 'semver', tagPrefix: 'cli/v' });
  await f.git.call(['tag', 'cli/v1.2.3']);
  await f.git.call(['push', 'origin', 'refs/tags/cli/v1.2.3']);
  await f.advance('code.txt', 'feat: new feature');
  const engine = f.engine({ cliff: undefined });
  const result = await engine.prepare();
  assert.equal(result.version, '1.3.0');
  assert.match(f.prs.get(1).body, /## \[1.3.0\] - 2026-10-03/);
  assert.match(f.prs.get(1).body, /new feature/);
  assert.doesNotMatch(f.prs.get(1).body, /initial implementation/);
  assert.equal([...f.prs.get(1).body.matchAll(/^## \[/gmu)].length, 1);
  await f.merge();
  const release = await f.engine({ cliff: undefined }).publish();
  assert.equal(release.version, '1.3.0');
});

test('git-cliff runs offline with external commands disabled and strips consumer overrides', async () => {
  const calls = [];
  const cliff = new Cliff(async (executable, args, options) => { calls.push({ executable, args, options }); return 'v1.2.4\n'; }, {
    GIT_CLIFF_CONFIG: '/malicious.toml', GIT_CLIFF_OUTPUT: '/overwrite', GH_TOKEN: 'private', PATH: '/trusted/path',
  });
  assert.equal(await cliff.bumped('/target', { paths: ['apps/cli'], tagPrefix: 'v' }, { sha: 'a'.repeat(40) }, 'b'.repeat(40)), 'v1.2.4');
  assert.ok(calls[0].args.includes('--offline'));
  assert.ok(calls[0].args.includes('--no-exec'));
  assert.deepEqual(calls[0].options.env, { PATH: '/trusted/path' });
});

test('real git-cliff filters scoped commits and advances a prefixed prerelease', { skip: !available }, async t => {
  const f = await fixture(t, { scheme: 'semver', paths: ['apps/cli'], tagPrefix: 'cli/v', prerelease: true, changelog: false, manifests: [] });
  await f.advance('apps/cli/code.txt', 'feat: initial cli');
  await f.git.call(['tag', 'cli/v1.2.3-rc.1']);
  await f.git.call(['push', 'origin', 'refs/tags/cli/v1.2.3-rc.1']);
  await f.advance('apps/ui/code.txt', 'feat: unrelated ui change');
  await f.advance('apps/cli/code.txt', 'fix: scoped cli fix');
  const result = await f.engine({ cliff: undefined }).prepare();
  assert.equal(result.version, '1.2.3-rc.2');
  assert.match(f.prs.get(1).body, /scoped cli fix/);
  assert.doesNotMatch(f.prs.get(1).body, /unrelated ui change/);
  assert.equal([...f.prs.get(1).body.matchAll(/^## \[/gmu)].length, 1);
});

test('real git-cliff preserves reviewed October notes during November publication and historical replay', { skip: !available }, async t => {
  const f = await fixture(t);
  const october = { cliff: undefined, clock: () => new Date('2026-10-31T12:00:00.000Z') };
  const november = { cliff: undefined, clock: () => new Date('2026-11-01T12:00:00.000Z') };
  const prepared = await f.engine(october).prepare();
  const originalNotes = JSON.parse(await f.git.file(f.prs.get(1).head.sha, '.datarose-release/release.json')).notes;
  await f.merge();
  const original = await f.engine(november).publish();
  assert.equal(original.version, prepared.version);
  assert.equal(f.releases.get(original.tag).body, originalNotes);
  await f.advance('code.txt', 'feat: November implementation');
  await f.engine(november).prepare();
  await f.merge(2);
  await f.engine(november).publish();
  await f.event({ action: 'closed', pull_request: { number: 1, merged: true } });
  f.mutations.length = 0;
  assert.deepEqual(await f.engine(november).publish(), original);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.releases.get(original.tag).body, originalNotes);
  assert.match(originalNotes, /^## \[2026\.10\.1\] - 2026-10-31/mu);
});
