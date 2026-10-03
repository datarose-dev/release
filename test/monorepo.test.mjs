import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { fixture } from './fixtures.mjs';

async function configure(f, independent) {
  for (const name of ['cli', 'ui']) {
    await mkdir(path.join(f.target, 'apps', name), { recursive: true });
    await writeFile(path.join(f.target, 'apps', name, 'package.json'), `{"name":"${name}","version":"0.0.0"}\n`);
  }
  const config = independent ? {
    baseBranch: 'master', units: Object.fromEntries(['cli', 'ui'].map(name => [name, {
      paths: [`apps/${name}`], tagPrefix: `${name}/v`, changelog: `apps/${name}/CHANGELOG.md`,
      manifests: [{ path: `apps/${name}/package.json`, format: 'json', key: ['version'] }],
    }])),
  } : {
    baseBranch: 'master', units: { release: {
      paths: ['apps/cli', 'apps/ui'], manifests: ['cli', 'ui'].map(name => ({ path: `apps/${name}/package.json`, format: 'json', key: ['version'] })),
    } },
  };
  await writeFile(path.join(f.target, '.release.json'), JSON.stringify(config, null, 2) + '\n');
  await f.git.call(['add', '.']);
  await f.git.call(['commit', '-m', 'feat: add applications']);
  await f.git.call(['push', 'origin', 'master']);
}

test('shared-version unit updates multiple scoped manifests without root or dependency rewrites', async t => {
  const f = await fixture(t);
  await configure(f, false);
  const result = await f.engine().prepare();
  const head = f.prs.get(1).head.sha;
  for (const name of ['cli', 'ui']) assert.equal(JSON.parse(await f.git.file(head, `apps/${name}/package.json`)).version, result.version);
  assert.equal(JSON.parse(await f.git.file(head, 'package.json')).version, '0.0.0');
  assert.equal(f.prs.get(1).head.ref, 'chore/datarose-release-automatization-for-v2026.10.1');
});

test('independent units infer managed PR unit despite caller default RELEASE_UNIT=release', async t => {
  const f = await fixture(t);
  await configure(f, true);
  const result = await f.engine({ env: { RELEASE_UNIT: 'cli' } }).prepare();
  const pr = f.prs.get(1);
  assert.equal(result.unit, 'cli');
  assert.equal(result.tag, 'cli/v2026.10.1');
  assert.equal(pr.head.ref, 'chore/datarose-release-automatization-cli-for-v2026.10.1');
  assert.equal(JSON.parse(await f.git.file(pr.head.sha, 'apps/cli/package.json')).version, result.version);
  assert.equal(JSON.parse(await f.git.file(pr.head.sha, 'apps/ui/package.json')).version, '0.0.0');
  await f.event({ action: 'created', issue: { number: 1, pull_request: {} }, comment: { body: '@datarose-release update', user: { login: 'writer' } } });
  assert.equal((await f.engine({ env: { RELEASE_UNIT: 'release' } }).update()).unit, 'cli');
  await f.merge();
  assert.equal((await f.engine({ env: { RELEASE_UNIT: 'release' } }).publish()).tag, 'cli/v2026.10.1');
});

test('scoped unit rejects release when only another unit changed', async t => {
  const f = await fixture(t);
  await configure(f, true);
  const source = await f.git.sha('HEAD');
  await f.git.call(['tag', 'cli/v2026.10.1', source]);
  await f.git.call(['push', 'origin', 'refs/tags/cli/v2026.10.1']);
  await f.advance('apps/ui/new.txt', 'feat: ui-only change');
  await assert.rejects(f.engine({ env: { RELEASE_UNIT: 'cli' } }).prepare(), /No relevant source changes/);
});
