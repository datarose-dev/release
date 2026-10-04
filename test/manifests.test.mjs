import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { editManifest, manifestChanges, prependChangelog } from '../src/manifests.mjs';
import { safeFile } from '../src/config.mjs';

test('JSON scalar edits preserve whitespace, CRLF and unrelated fields', () => {
  const input = '{\r\n  "name" : "demo",\r\n  "version" : "0.1.0",\r\n  "nested": {"version":"keep"}\r\n}\r\n';
  const edited = editManifest(input, { format: 'json', key: ['version'] }, '2026.10.1');
  assert.equal(edited, input.replace('0.1.0', '2026.10.1'));
  assert.throws(() => editManifest('{"version":"1","version":"2"}', { format: 'json', key: ['version'] }, '3'), /Invalid JSON/);
  assert.throws(() => editManifest('{"name":"demo"}', { format: 'json', key: ['version'] }, '3'), /does not exist/);
});

test('YAML preserves comments, anchors outside target, CRLF and rejects ambiguous fields', () => {
  const input = 'defaults: &defaults\r\n  label: keep\r\npackage:\r\n  version: \'0.1.0\' # keep comment\r\ncopy: *defaults\r\n';
  assert.equal(editManifest(input, { format: 'yaml', key: ['package', 'version'] }, '1.2.3'), input.replace("'0.1.0'", '"1.2.3"'));
  for (const text of ['version: &v "1"\ncopy: *v\n', 'version: *v\n', 'base: &b {version: "1"}\npackage: {<<: *b, version: "1"}\n', 'version: |\n  1\n', 'version: !custom "1"\n']) {
    assert.throws(() => editManifest(text, { format: 'yaml', key: text.includes('package:') ? ['package', 'version'] : ['version'] }, '2'));
  }
});

test('TOML localized regular tables preserve comments and CRLF', () => {
  const input = '# header\r\n[workspace.package]\r\nversion = \'0.1.0\'  # keep\r\nlicense = "MIT"\r\n[dependencies]\r\nfoo = { version = "1" }\r\n';
  assert.equal(editManifest(input, { format: 'toml', key: ['workspace', 'package', 'version'] }, '2.0.0'), input.replace("'0.1.0'", '"2.0.0"'));
  for (const text of ['package = {version = "1"}\n', 'package.version = "1"\n', '["package"]\nversion = "1"\n', '[package]\nversion = """1"""\n', '[package]\nversion = "1"\nversion = "2"\n']) assert.throws(() => editManifest(text, { format: 'toml', key: ['package', 'version'] }, '2'));
});

test('npm root lock synchronization changes only two matching version scalars', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"version":"0.1.0","scripts":{"evil":"exit 1"}}\n');
  const lock = '{\r\n "version": "0.1.0",\r\n "lockfileVersion": 3,\r\n "packages": {"": {"version": "0.1.0"}, "node_modules/example": {"version": "4.0.0"}}\r\n}\r\n';
  await writeFile(path.join(root, 'package-lock.json'), lock);
  const unit = { manifests: [{ path: 'package.json', format: 'json', key: ['version'] }] };
  const changes = await manifestChanges(root, unit, '0.2.0');
  assert.equal(changes.get('package-lock.json'), lock.replaceAll('0.1.0', '0.2.0'));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await assert.rejects(manifestChanges(root, unit, '0.2.0'), /Unsupported lockfile/);
});

test('unsupported Cargo locks, omitted Composer fields, parent locks and symlinks fail', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'release-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'Cargo.toml'), '[package]\nversion = "1.0.0"\n');
  await writeFile(path.join(root, 'Cargo.lock'), 'version = 4\n');
  await assert.rejects(manifestChanges(root, { manifests: [{ path: 'Cargo.toml', format: 'toml', key: ['package', 'version'] }] }, '1.1.0'), /Unsupported lockfile/);
  assert.throws(() => editManifest('{"name":"owner/project"}', { format: 'json', key: ['version'] }, '1.0.0'), /does not exist/);
  await symlink('Cargo.toml', path.join(root, 'version.toml'));
  await assert.rejects(safeFile(root, 'version.toml'), /Symlinks/);
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested/package.json'), '{"version":"1.0.0"}');
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await assert.rejects(manifestChanges(root, { manifests: [{ path: 'nested/package.json', format: 'json', key: ['version'] }] }, '1.1.0'), /parent npm/);
});

test('changelog prepend preserves existing content and CRLF', () => {
  const original = '# Changelog\r\n\r\nOld content\r\n';
  assert.equal(prependChangelog(original, '## [1.0.0] - 2026-10-03\n\n- Fix\n'), '# Changelog\r\n\r\n## [1.0.0] - 2026-10-03\r\n\r\n- Fix\r\n\r\nOld content\r\n');
});
