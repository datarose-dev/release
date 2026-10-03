import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, configDigest, booleanOverride, releaseBranch } from '../src/config.mjs';
import { nextVersion, validateVersion, previousRelease } from '../src/versions.mjs';

const now = new Date('2026-10-03T12:00:00.000Z');
const unit = (scheme = 'calver') => parseConfig(JSON.stringify({ units: { release: { scheme, paths: ['.'] } } })).units.release;

test('CalVer uses UTC, month rollover, and counters starting at one', () => {
  assert.equal(nextVersion({ unit: unit(), now }), '2026.10.1');
  assert.equal(nextVersion({ unit: unit(), now, previous: { version: '2026.10.9' } }), '2026.10.10');
  assert.equal(nextVersion({ unit: unit(), now, previous: { version: '2026.9.40' } }), '2026.10.1');
  assert.equal(nextVersion({ unit: unit(), now: new Date('2027-01-01T00:00:00Z'), previous: { version: '2026.12.50' } }), '2027.1.1');
});

test('CalVer rejects future, padded, malformed, stale and regressing versions', () => {
  for (const version of ['2027.1.1', '2026.11.1', '2026.01.1', '2026.0.1', '2026.10.0', '2026.13.1', 'v2026.10.1', '2026.10.1+meta']) assert.throws(() => validateVersion(version, 'calver', now));
  assert.throws(() => nextVersion({ unit: unit(), now, forced: '2026.9.2' }), /Stale/);
  assert.throws(() => nextVersion({ unit: unit(), now, forced: '2026.10.1', previous: { version: '2026.10.1' } }), /does not advance/);
  assert.throws(() => previousRelease(['vnot-a-version'], unit(), now), /Invalid canonical/);
});

test('SemVer bootstrap, git-cliff increment, forced versions, and release flags', () => {
  assert.equal(nextVersion({ unit: unit('semver'), now }), '0.1.0');
  assert.equal(nextVersion({ unit: unit('semver'), now, previous: { version: '1.2.3' }, bumped: 'v1.3.0' }), '1.3.0');
  assert.equal(nextVersion({ unit: unit('semver'), now, forced: '2.0.0', draft: true }), '2.0.0');
  assert.equal(nextVersion({ unit: unit('semver'), now, draft: true }), '0.1.0');
  assert.equal(nextVersion({ unit: unit(), now, draft: true }), '2026.10.1');
  assert.equal(nextVersion({ unit: unit('semver'), now, forced: '2.0.0', draft: true, prerelease: true }), '2.0.0');
  assert.equal(nextVersion({ unit: unit(), now, prerelease: true, draft: true }), '2026.10.1-rc.1');
  assert.equal(nextVersion({ unit: unit('semver'), now, forced: '2.0.0-beta.2', prerelease: true }), '2.0.0-beta.2');
  assert.throws(() => nextVersion({ unit: unit('semver'), now, forced: '2.0.0-beta.2' }), /requires/);
  assert.throws(() => nextVersion({ unit: unit('semver'), now, previous: { version: '1.2.3' }, bumped: 'v1.2.3' }), /does not advance/);
});

test('config rejects traversal, overlapping units, unsupported properties and reserved writes', () => {
  const config = { units: { release: { paths: ['.'], manifests: [{ path: 'package.json', format: 'json', key: ['version'] }] } } };
  assert.equal(parseConfig(JSON.stringify(config)).baseBranch, 'master');
  for (const file of ['../package.json', '/package.json', '.git/config', '.datarose-release/release.json', '.github/workflows/test.yml', '.release.json', 'package-lock.json', 'cliff.toml', 'release.schema.json']) {
    const invalid = structuredClone(config);
    invalid.units.release.manifests[0].path = file;
    assert.throws(() => parseConfig(JSON.stringify(invalid)));
  }
  assert.throws(() => parseConfig(JSON.stringify({ units: { release: { paths: ['packages', 'packages/app'] } } })), /overlap/);
  assert.throws(() => parseConfig(JSON.stringify({ units: { one: { paths: ['a'], tagPrefix: 'v', changelog: false }, two: { paths: ['b'], tagPrefix: 'v', changelog: false } } })), /prefixes overlap/);
  assert.throws(() => parseConfig(JSON.stringify({ units: { release: { paths: ['.'], hooks: ['npm run evil'] } } })), /unsupported/);
  assert.throws(() => parseConfig(JSON.stringify({ baseBranch: '--help', units: { release: { paths: ['.'] } } })), /baseBranch/);
  assert.throws(() => parseConfig(JSON.stringify({ units: { release: { paths: ['.'], tagPrefix: 'bad..v' } } })), /tagPrefix/);
  assert.throws(() => parseConfig('{"units":{"release":{"paths":["."]}},"units":{"release":{"paths":["."]}}}'), /duplicate/);
  assert.throws(() => parseConfig(JSON.stringify({ baseBranch: null, units: { release: { paths: ['.'] } } })), /must be a string/);
  assert.throws(() => parseConfig(JSON.stringify({ units: { release: { paths: ['.'], initialVersion: null } } })), /cannot be null/);
  assert.throws(() => parseConfig(JSON.stringify({ baseBranch: 'chore/datarose-release-automatization-for-v1.0.0', units: { release: { paths: ['.'] } } })), /reserved managed/);
  assert.throws(() => booleanOverride('TRUE', false, 'FLAG'), /true or false/);
  assert.equal(booleanOverride('', true, 'FLAG'), true);
  assert.equal(releaseBranch(parseConfig(JSON.stringify(config)), 'release', '2026.10.1'), 'chore/datarose-release-automatization-for-v2026.10.1');
});

test('releaseAuthor defaults explicitly and binds config digest to exact GitHub identity', () => {
  const base = { units: { release: { paths: ['.'] } } };
  const defaultConfig = parseConfig(JSON.stringify(base));
  assert.equal(defaultConfig.releaseAuthor, 'github-actions[bot]');
  assert.equal(configDigest(defaultConfig), configDigest(parseConfig(JSON.stringify({ ...base, releaseAuthor: 'github-actions[bot]' }))));
  for (const releaseAuthor of ['release-maintainer', 'release-automation[bot]']) {
    const config = parseConfig(JSON.stringify({ ...base, releaseAuthor }));
    assert.equal(config.releaseAuthor, releaseAuthor);
    assert.notEqual(configDigest(config), configDigest(defaultConfig));
  }
  for (const releaseAuthor of ['', null, 42, '*', '*[bot]', 'any/[bot]', 'someone[bot]extra', '[bot]', '-login', 'login-', 'login\n', 'x'.repeat(40)]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...base, releaseAuthor })), /releaseAuthor/);
  }
});

test('consumer src/test manifest paths are allowed while protected engine/config paths remain guarded', () => {
  for (const [directory, filename, format] of [['src', 'version.yaml', 'yaml'], ['test', 'version.json', 'json']]) {
    const config = parseConfig(JSON.stringify({ units: { release: { paths: [directory], changelog: false, manifests: [{ path: `${directory}/${filename}`, format, key: ['version'] }] } } }));
    assert.equal(config.units.release.manifests[0].path, `${directory}/${filename}`);
  }
});
