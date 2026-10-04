import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import semver from 'semver';
import { parseDocument } from 'yaml';
import { invariant } from './errors.mjs';

const reserved = new Set(['.git', '.datarose-release', '.github', 'node_modules']);
const engineFiles = new Set(['cliff.toml', 'release.schema.json', 'package-lock.json']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function relativePath(value, { directory = false, writable = false } = {}) {
  invariant(typeof value === 'string' && value.length > 0 && value.length < 512, 'Paths must be nonempty relative strings.');
  if (value === '.' && directory) return value;
  invariant(!path.posix.isAbsolute(value) && !value.includes('\\') && !/[\x00-\x1f\x7f:*?\[\]{}]/u.test(value), `Unsafe path: ${value}`);
  const parts = value.split('/');
  invariant(parts.every(part => part && part !== '.' && part !== '..' && part !== '.git'), `Unsafe path: ${value}`);
  if (writable) {
    invariant(!reserved.has(parts[0]) && !engineFiles.has(value) && !/^\.release(?:\.|$)/u.test(value), `Reserved release write path: ${value}`);
    invariant(!value.endsWith('/package-lock.json'), 'Configure package.json instead; its supported package-lock.json is synchronized automatically.');
  }
  return value;
}

export function covered(file, directories) {
  return directories.some(directory => directory === '.' || file.startsWith(`${directory}/`));
}

function overlap(a, b) {
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function onlyKeys(value, allowed, context) {
  invariant(object(value), `${context} must be an object.`);
  invariant(Object.keys(value).every(key => allowed.includes(key)), `${context} has an unsupported property.`);
}

export function validRef(value) {
  return typeof value === 'string' && value.length < 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.')
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
}

export function validLogin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/u.test(value);
}

export function parseConfig(text, configPath = '.release.json') {
  relativePath(configPath);
  invariant(!reserved.has(configPath.split('/')[0]), 'Release config cannot be in a reserved directory.');
  let raw;
  try { raw = JSON.parse(text); } catch { invariant(false, 'Release config must be valid JSON.'); }
  invariant(parseDocument(text, { uniqueKeys: true, strict: true }).errors.length === 0, 'Release config contains duplicate or ambiguous JSON keys.');
  onlyKeys(raw, ['baseBranch', 'releaseAuthor', 'units', '$schema'], 'Release config');
  invariant(raw.baseBranch === undefined || typeof raw.baseBranch === 'string', 'baseBranch must be a string.');
  invariant(raw.$schema === undefined || typeof raw.$schema === 'string', '$schema must be a string.');
  invariant(validLogin(raw.releaseAuthor === undefined ? 'github-actions[bot]' : raw.releaseAuthor), 'releaseAuthor must be an exact GitHub login, optionally ending in [bot]; wildcards are not supported.');
  invariant(validRef(raw.baseBranch ?? 'master'), 'Invalid baseBranch.');
  invariant(!(raw.baseBranch ?? 'master').startsWith('chore/datarose-release-automatization'), 'baseBranch cannot use the reserved managed release branch prefix.');
  invariant(object(raw.units) && Object.keys(raw.units).length > 0, 'Configure at least one release unit.');
  const units = Object.create(null);
  const allDirectories = [];
  const allWrites = new Set([configPath]);
  for (const [name, input] of Object.entries(raw.units)) {
    invariant(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name), `Invalid release unit: ${name}`);
    onlyKeys(input, ['scheme', 'paths', 'tagPrefix', 'initialVersion', 'changelog', 'githubRelease', 'draft', 'prerelease', 'manifests'], `Unit ${name}`);
    invariant(Object.values(input).every(value => value !== null), `Unit ${name} properties cannot be null.`);
    invariant(['calver', 'semver'].includes(input.scheme ?? 'calver'), `Invalid version scheme for ${name}.`);
    invariant(Array.isArray(input.paths) && input.paths.length > 0, `Unit ${name} requires explicit paths.`);
    const paths = input.paths.map(value => relativePath(value, { directory: true }));
    for (const directory of paths) {
      invariant(!allDirectories.some(other => overlap(directory, other)), `Release paths overlap: ${directory}`);
      allDirectories.push(directory);
    }
    const tagPrefix = input.tagPrefix ?? 'v';
    invariant(typeof tagPrefix === 'string' && (tagPrefix === '' || validRef(`${tagPrefix}1.0.0`)), `Invalid tagPrefix for ${name}.`);
    invariant(semver.valid(input.initialVersion ?? '0.1.0') === (input.initialVersion ?? '0.1.0') && !semver.prerelease(input.initialVersion ?? '0.1.0') && !(input.initialVersion ?? '0.1.0').includes('+'), 'initialVersion must be a canonical stable SemVer without build metadata.');
    const changelog = input.changelog ?? 'CHANGELOG.md';
    if (changelog !== false) relativePath(changelog, { writable: true });
    const manifests = input.manifests ?? [];
    invariant(Array.isArray(manifests), `Unit ${name} manifests must be an array.`);
    for (const manifest of manifests) {
      onlyKeys(manifest, ['path', 'format', 'key'], 'Manifest');
      relativePath(manifest.path, { writable: true });
      invariant(covered(manifest.path, paths), `Manifest ${manifest.path} is outside unit paths.`);
      invariant(['json', 'yaml', 'toml'].includes(manifest.format), 'Manifest format must be json, yaml, or toml.');
      invariant(Array.isArray(manifest.key) && manifest.key.length > 0 && manifest.key.every(key => typeof key === 'string' && key.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(key)), 'Manifest key must be an array of safe, nonempty strings.');
    }
    for (const file of [...manifests.map(manifest => manifest.path), ...(changelog === false ? [] : [changelog])]) {
      invariant(!allWrites.has(file), `Duplicate release write path: ${file}`);
      invariant(![...allWrites].some(other => other.startsWith(`${file}/`) || file.startsWith(`${other}/`)), `Release write paths overlap: ${file}`);
      allWrites.add(file);
    }
    for (const flag of ['githubRelease', 'draft', 'prerelease']) invariant(input[flag] === undefined || typeof input[flag] === 'boolean', `${flag} must be boolean.`);
    units[name] = {
      scheme: input.scheme ?? 'calver', paths, tagPrefix,
      initialVersion: input.initialVersion ?? '0.1.0', changelog,
      githubRelease: input.githubRelease ?? true, draft: input.draft ?? false,
      prerelease: input.prerelease ?? false, manifests,
    };
  }
  const prefixes = Object.values(units).map(unit => unit.tagPrefix);
  invariant(prefixes.every((prefix, index) => !prefixes.some((other, otherIndex) => index !== otherIndex && (prefix.startsWith(other) || other.startsWith(prefix)))), 'Release tag prefixes overlap.');
  return { baseBranch: raw.baseBranch ?? 'master', releaseAuthor: raw.releaseAuthor ?? 'github-actions[bot]', units };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function configDigest(config) {
  return createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex');
}

export async function safeFile(root, relative, { missing = false, directory = false } = {}) {
  relativePath(relative, { directory });
  const realRoot = await realpath(root);
  let current = realRoot;
  if (relative === '.') return realRoot;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (missing && error.code === 'ENOENT') return path.join(realRoot, relative);
      throw error;
    }
    invariant(!stat.isSymbolicLink(), `Symlinks are not supported: ${relative}`);
    invariant(index === parts.length - 1 ? (directory ? stat.isDirectory() : stat.isFile()) : stat.isDirectory(), `Unexpected file type: ${relative}`);
  }
  return current;
}

export function booleanOverride(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  invariant(value === 'true' || value === 'false', `${name} must be true or false.`);
  return value === 'true';
}

export function releaseBranch(config, unit, version) {
  return Object.keys(config.units).length === 1
    ? `chore/datarose-release-automatization-for-v${version}`
    : `chore/datarose-release-automatization-${unit}-for-v${version}`;
}
