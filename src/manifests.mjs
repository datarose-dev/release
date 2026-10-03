import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument, isMap, isScalar } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { invariant, ReleaseError } from './errors.mjs';
import { safeFile } from './config.mjs';

function valueAt(value, keys) {
  for (const key of keys) {
    invariant(value !== null && typeof value === 'object' && Object.hasOwn(value, key), `Configured version field does not exist: ${keys.join('.')}`);
    value = value[key];
  }
  return value;
}

function scalarEdit(text, keys, version, format) {
  if (format === 'json') {
    try { JSON.parse(text); } catch { throw new ReleaseError('Manifest is not valid JSON.'); }
  }
  const document = parseDocument(text, { uniqueKeys: true, strict: true, keepSourceTokens: true });
  invariant(document.errors.length === 0, `Invalid ${format.toUpperCase()} manifest: ${document.errors[0]?.message ?? ''}`);
  let node = document.contents;
  for (const key of keys) {
    invariant(isMap(node) && !node.anchor, 'Version field must be in an unanchored mapping, not an alias, sequence, or inline inherited field.');
    invariant(!node.items.some(pair => isScalar(pair.key) && pair.key.value === '<<'), 'YAML merge mappings are not supported for version fields.');
    const pairs = node.items.filter(pair => isScalar(pair.key) && pair.key.value === key);
    invariant(pairs.length === 1, `Configured version field does not exist or is ambiguous: ${keys.join('.')}`);
    node = pairs[0].value;
  }
  invariant(isScalar(node) && typeof node.value === 'string' && !node.anchor && node.range, 'Version field must be an existing, unanchored string scalar.');
  invariant(!node.tag || node.tag === 'tag:yaml.org,2002:str', 'Custom YAML tags are not supported for version fields.');
  invariant(!['BLOCK_LITERAL', 'BLOCK_FOLDED'].includes(node.type), 'Multiline YAML version fields are not supported.');
  const result = text.slice(0, node.range[0]) + JSON.stringify(version) + text.slice(node.range[1]);
  if (format === 'json') invariant(valueAt(JSON.parse(result), keys) === version, 'JSON version edit did not round-trip.');
  else {
    const verified = parseDocument(result, { uniqueKeys: true, strict: true });
    invariant(verified.errors.length === 0 && valueAt(verified.toJS({ maxAliasCount: 100 }), keys) === version, 'YAML version edit did not round-trip.');
  }
  return result;
}

function tomlEdit(text, keys, version) {
  let parsed;
  try { parsed = parseToml(text); } catch (error) { throw new ReleaseError(`Invalid TOML manifest: ${error.message}`); }
  invariant(typeof valueAt(parsed, keys) === 'string', 'TOML version field must be an existing string.');
  invariant(keys.every(key => /^[A-Za-z0-9_-]+$/u.test(key)), 'Only bare TOML table names and scalar keys are supported.');
  invariant(!text.includes('"""') && !text.includes("'''"), 'Multiline TOML strings are not supported by localized version editing.');
  const table = keys.slice(0, -1).join('.');
  const key = keys.at(-1);
  const hits = [];
  let section = '';
  let offset = 0;
  for (const line of text.split(/(?<=\n)/u)) {
    const body = line.replace(/\r?\n$/u, '');
    if (/^\s*\[/u.test(body)) {
      const header = /^\s*\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\s*(?:#.*)?$/u.exec(body);
      section = header?.[1] ?? null;
    } else if (section === table) {
      const match = /^([ \t]*)([A-Za-z0-9_-]+)([ \t]*=[ \t]*)("(?:\\.|[^"\\])*"|'[^']*')([ \t]*(?:#.*)?)$/u.exec(body);
      if (match?.[2] === key) {
        const start = offset + match[1].length + match[2].length + match[3].length;
        hits.push([start, start + match[4].length]);
      }
    }
    offset += line.length;
  }
  invariant(hits.length === 1, 'TOML version field must be a single-line scalar in a regular table; inline, dotted, quoted, and ambiguous fields are unsupported.');
  const [start, end] = hits[0];
  const result = text.slice(0, start) + JSON.stringify(version) + text.slice(end);
  invariant(valueAt(parseToml(result), keys) === version, 'TOML version edit did not round-trip.');
  return result;
}

export function editManifest(text, manifest, version) {
  return manifest.format === 'toml' ? tomlEdit(text, manifest.key, version) : scalarEdit(text, manifest.key, version, manifest.format);
}

async function exists(root, file) {
  try { await safeFile(root, file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function ancestors(directory) {
  const result = [];
  while (directory !== '.') { result.push(directory); directory = path.posix.dirname(directory); }
  return [...result, '.'];
}

export async function manifestChanges(root, unit, version) {
  const changes = new Map();
  for (const manifest of unit.manifests) {
    const filename = await safeFile(root, manifest.path);
    const original = await readFile(filename, 'utf8');
    const edited = editManifest(original, manifest, version);
    if (edited === original) continue;
    changes.set(manifest.path, edited);
    const basename = path.posix.basename(manifest.path);
    const directory = path.posix.dirname(manifest.path);
    if (basename === 'package.json') {
      invariant(manifest.format === 'json' && JSON.stringify(manifest.key) === '["version"]', 'package.json must configure its root version field.');
      for (const ancestor of ancestors(directory)) {
        for (const lock of ['yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']) invariant(!await exists(root, path.posix.join(ancestor, lock)), `Unsupported lockfile ${path.posix.join(ancestor, lock)}; version synchronization is not implemented.`);
        const lock = path.posix.join(ancestor, 'package-lock.json');
        if (await exists(root, lock)) {
          invariant(ancestor === directory, 'A parent npm workspace lockfile cannot be synchronized for an independently versioned nested package.');
          const lockText = await readFile(await safeFile(root, lock), 'utf8');
          const parsed = JSON.parse(lockText);
          invariant([2, 3].includes(parsed.lockfileVersion) && parsed.packages?.[''], 'Only package-lock.json v2/v3 with a root package entry is supported.');
          invariant(parsed.version === JSON.parse(original).version && parsed.packages[''].version === parsed.version, 'package-lock.json root versions are already stale.');
          const rootEdited = editManifest(lockText, { format: 'json', key: ['version'] }, version);
          changes.set(lock, editManifest(rootEdited, { format: 'json', key: ['packages', '', 'version'] }, version));
        }
      }
    }
    if (basename === 'Cargo.toml' || basename === 'composer.json') {
      const lock = basename === 'Cargo.toml' ? 'Cargo.lock' : 'composer.lock';
      for (const ancestor of ancestors(directory)) invariant(!await exists(root, path.posix.join(ancestor, lock)), `Unsupported lockfile ${path.posix.join(ancestor, lock)}; version synchronization is not implemented.`);
    }
  }
  return changes;
}

export function prependChangelog(original, notes) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const section = notes.trim().replace(/\r?\n/gu, newline);
  if (!original) return `# Changelog${newline}${newline}${section}${newline}`;
  const title = /^# [^\r\n]+\r?\n(?:\r?\n)?/u.exec(original);
  const offset = title ? title[0].length : 0;
  return original.slice(0, offset) + section + newline + newline + original.slice(offset);
}

export async function writeChanges(root, changes) {
  for (const [file, text] of changes) await writeFile(await safeFile(root, file, { missing: true }), text, 'utf8');
}
