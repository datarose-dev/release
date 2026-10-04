import semver from 'semver';
import { invariant } from './errors.mjs';

export function validateVersion(version, scheme, now = new Date()) {
  invariant(typeof version === 'string' && version.length < 100 && semver.valid(version) === version && !version.includes('+') && !version.endsWith('.lock'), `Invalid canonical version: ${version}`);
  if (scheme === 'calver') {
    const match = /^(\d{4})\.([1-9]|1[0-2])\.([1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.exec(version);
    invariant(match, `Invalid CalVer: ${version}; expected YEAR.MONTH.counter (unpadded month, counter >= 1).`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    invariant(year >= 1970 && Number.isSafeInteger(Number(match[3])), `Invalid CalVer: ${version}`);
    invariant(year < now.getUTCFullYear() || (year === now.getUTCFullYear() && month <= now.getUTCMonth() + 1), `Future CalVer: ${version}`);
  }
  return version;
}

export function previousRelease(tags, unit, now = new Date(), ignoredTag) {
  const matches = tags.filter(tag => tag.startsWith(unit.tagPrefix) && tag !== ignoredTag).map(tag => {
    const version = tag.slice(unit.tagPrefix.length);
    validateVersion(version, unit.scheme, now);
    return { tag, version };
  });
  matches.sort((a, b) => semver.rcompare(a.version, b.version));
  return matches[0] ?? null;
}

export function nextVersion({ unit, previous, now = new Date(), forced, bumped, draft = unit.draft, prerelease = unit.prerelease }) {
  let version = forced;
  if (!version) {
    if (unit.scheme === 'calver') {
      if (previous) validateVersion(previous.version, 'calver', now);
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const sameMonth = previous && semver.major(previous.version) === year && semver.minor(previous.version) === month;
      version = `${year}.${month}.${sameMonth ? semver.patch(previous.version) + 1 : 1}`;
    } else if (!previous) {
      version = unit.initialVersion;
    } else {
      invariant(typeof bumped === 'string', 'git-cliff did not calculate a SemVer increment.');
      version = bumped.startsWith(unit.tagPrefix) ? bumped.slice(unit.tagPrefix.length) : bumped;
    }
  }
  validateVersion(version, unit.scheme, now);
  if (!forced && !semver.prerelease(version) && prerelease) version += '-rc.1';
  invariant(!semver.prerelease(version) || draft || prerelease, 'Prerelease version requires draft or prerelease=true.');
  if (unit.scheme === 'calver') {
    invariant(semver.major(version) === now.getUTCFullYear() && semver.minor(version) === now.getUTCMonth() + 1, `Stale CalVer: ${version}; release must use the current UTC month.`);
  }
  invariant(!previous || semver.gt(version, previous.version), `Version ${version} does not advance ${previous?.version}.`);
  return validateVersion(version, unit.scheme, now);
}
