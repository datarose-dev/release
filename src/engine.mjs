import path from 'node:path';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { parseConfig, configDigest, relativePath, safeFile, booleanOverride, releaseBranch } from './config.mjs';
import { validateVersion, previousRelease, nextVersion } from './versions.mjs';
import { manifestChanges, prependChangelog, writeChanges } from './manifests.mjs';
import { Git, isSha } from './git.mjs';
import { GitHub, managedPr } from './github.mjs';
import { Cliff, prBody, toolRoot } from './notes.mjs';
import { invariant } from './errors.mjs';
import { run } from './runner.mjs';

const statePath = unit => `.datarose-release/${unit}.json`;
const planKeys = ['schemaVersion', 'unit', 'version', 'tag', 'sourceSha', 'previousTag', 'previousSha', 'configDigest', 'releaseDate', 'draft', 'prerelease', 'notes'];
const managedUnit = body => /^<!-- datarose-release:([A-Za-z][A-Za-z0-9_-]{0,63}) -->\n/u.exec(body ?? '')?.[1];

export function parsePlan(text) {
  let plan;
  try { plan = JSON.parse(text); } catch { invariant(false, 'Managed release state is not valid JSON.'); }
  invariant(plan && typeof plan === 'object' && Object.keys(plan).length === planKeys.length && planKeys.every(key => Object.hasOwn(plan, key)), 'Managed release state has an unsupported shape.');
  invariant(plan.schemaVersion === 1 && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(plan.unit), 'Unsupported release state schema or unit.');
  invariant(isSha(plan.sourceSha) && (plan.previousSha === null || isSha(plan.previousSha)), 'Invalid release state commit SHA.');
  invariant((plan.previousTag === null) === (plan.previousSha === null) && (plan.previousTag === null || typeof plan.previousTag === 'string'), 'Invalid previous release state.');
  invariant(typeof plan.configDigest === 'string' && /^[0-9a-f]{64}$/u.test(plan.configDigest), 'Invalid release config digest.');
  invariant(typeof plan.releaseDate === 'string' && !Number.isNaN(Date.parse(plan.releaseDate)) && new Date(plan.releaseDate).toISOString() === plan.releaseDate, 'Release date must be an ISO UTC timestamp.');
  invariant(typeof plan.draft === 'boolean' && typeof plan.prerelease === 'boolean', 'Invalid release flags.');
  invariant(typeof plan.notes === 'string' && plan.notes.length > 0 && plan.notes.length < 1024 * 1024, 'Invalid reviewed release notes.');
  return plan;
}

export class ReleaseEngine {
  constructor({ env = process.env, runner = run, clock = () => new Date(), git, github, cliff } = {}) {
    this.env = env;
    this.clock = clock;
    invariant(env.RELEASE_REPOSITORY_DIR && path.isAbsolute(env.RELEASE_REPOSITORY_DIR), 'Set RELEASE_REPOSITORY_DIR to the absolute target checkout path.');
    this.git = git ?? new Git(env.RELEASE_REPOSITORY_DIR, runner, env);
    this.github = github;
    this.runner = runner;
    this.cliff = cliff ?? new Cliff(runner, env);
    this.configPath = relativePath(env.RELEASE_CONFIG || '.release.json');
    this.repository = env.GITHUB_REPOSITORY;
  }

  async initialize(remote = false) {
    await this.git.clean();
    if (remote) {
      invariant(await realpath(this.git.root) !== await realpath(toolRoot), 'Keep trusted tool checkout separate from the release target checkout.');
      this.github ??= new GitHub(this.repository, this.runner, this.env, this.git.root);
    }
  }

  async configuration(ref) {
    return parseConfig(await this.git.file(ref, this.configPath), this.configPath);
  }

  async baseConfiguration() {
    const repository = await this.github.api(`repos/${this.repository}`);
    invariant(typeof repository.default_branch === 'string', 'GitHub did not return the default branch.');
    // Validate before allowing a ref to become a fetch argument.
    const seed = parseConfig(JSON.stringify({ baseBranch: repository.default_branch, units: { release: { paths: ['.'] } } }));
    let sourceSha = await this.git.fetchBase(seed.baseBranch);
    let config = await this.configuration(sourceSha);
    if (config.baseBranch !== seed.baseBranch) {
      sourceSha = await this.git.fetchBase(config.baseBranch);
      const configured = await this.configuration(sourceSha);
      invariant(configured.baseBranch === config.baseBranch, 'Default-branch and base-branch release configs disagree on baseBranch.');
      config = configured;
    }
    return { config, sourceSha };
  }

  async previous(unit, sourceSha, ignoredTag) {
    const previous = previousRelease(await this.git.tags(), unit, this.clock(), ignoredTag);
    if (previous) {
      previous.sha = await this.git.sha(`refs/tags/${previous.tag}`);
      invariant(await this.git.ancestor(previous.sha, sourceSha), `Previous tag ${previous.tag} is not an ancestor of the release source.`);
    }
    return previous;
  }

  async recordedPrevious(plan, unit, date) {
    if (plan.previousTag === null) return null;
    invariant(plan.previousTag.startsWith(unit.tagPrefix), 'Recorded previous tag belongs to a different release unit.');
    const version = validateVersion(plan.previousTag.slice(unit.tagPrefix.length), unit.scheme, date);
    const sha = await this.git.sha(`refs/tags/${plan.previousTag}`);
    invariant(sha === plan.previousSha && await this.git.remoteTag(plan.previousTag) === sha, 'Recorded previous release tag no longer points to its expected commit.');
    invariant(await this.git.ancestor(sha, plan.sourceSha), 'Recorded previous release is not an ancestor of the pinned source.');
    return { tag: plan.previousTag, version, sha };
  }

  async hasChanges(unit, previous, sourceSha) {
    const range = previous ? `${previous.sha}..${sourceSha}` : sourceSha;
    return (await this.git.call(['log', '--format=%H', range, '--', ...unit.paths])).trim() !== '';
  }

  async generatedNotes(worktree, unit, plan) {
    if (!await this.hasChanges(unit, plan.previousTag ? { sha: plan.previousSha } : null, plan.sourceSha)) {
      return `## [${plan.version}] - ${plan.releaseDate.slice(0, 10)}\n\nNo source changes (explicit forced release).\n`;
    }
    return this.cliff.notes(worktree.root, unit, plan);
  }

  async expectedChanges(worktree, unit, plan) {
    for (const directory of unit.paths) await safeFile(worktree.root, directory, { directory: true });
    const changes = await manifestChanges(worktree.root, unit, plan.version);
    if (unit.changelog !== false) {
      const file = await safeFile(worktree.root, unit.changelog, { missing: true });
      let original = '';
      try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      changes.set(unit.changelog, prependChangelog(original, plan.notes));
    }
    await safeFile(worktree.root, statePath(plan.unit), { missing: true });
    changes.set(statePath(plan.unit), JSON.stringify(plan, null, 2) + '\n');
    return changes;
  }

  async validatePlan(plan, head, { mergeSha, pr, trustedBaseSha, exactBody = false } = {}) {
    invariant(isSha(trustedBaseSha) && await this.git.ancestor(plan.sourceSha, trustedBaseSha), 'Pinned release source is not in the trusted base branch history.');
    const config = await this.configuration(plan.sourceSha);
    const unit = config.units[plan.unit];
    invariant(unit, `Unknown release unit: ${plan.unit}`);
    invariant(configDigest(config) === plan.configDigest, 'Release config digest does not match the pinned source.');
    const now = this.clock();
    const releaseDate = new Date(plan.releaseDate);
    invariant(releaseDate <= now, 'Release plan has a future date.');
    invariant(plan.tag === `${unit.tagPrefix}${plan.version}`, 'Release tag does not match unit version.');
    const branch = releaseBranch(config, plan.unit, plan.version);
    invariant(branch !== config.baseBranch, 'Managed release branch cannot be the target base branch.');
    if (pr) {
      managedPr(pr, { repository: this.repository, branch, base: config.baseBranch, releaseAuthor: config.releaseAuthor, merged: Boolean(mergeSha) });
      invariant(managedUnit(pr.body) === plan.unit, 'Release PR is missing its managed identity.');
      if (exactBody) invariant(pr.body === prBody(plan), 'Release PR body differs from the reviewed release plan.');
    }
    if (!mergeSha && unit.scheme === 'calver') {
      invariant(releaseDate.getUTCFullYear() === now.getUTCFullYear() && releaseDate.getUTCMonth() === now.getUTCMonth(), 'CalVer plan belongs to a previous UTC month; prepare a new release PR instead of refreshing its version.');
    }
    const validationDate = mergeSha ? releaseDate : now;
    validateVersion(plan.version, unit.scheme, validationDate);
    const remoteTag = mergeSha ? await this.git.remoteTag(plan.tag) : null;
    invariant(!remoteTag || remoteTag === mergeSha, 'Remote release tag already exists on a different commit; never overwrite it.');
    // Only a matching remote tag establishes publication. A local-only failed push does not permit historical replay.
    const previous = remoteTag ? await this.recordedPrevious(plan, unit, releaseDate) : await this.previous(unit, plan.sourceSha, mergeSha ? plan.tag : undefined);
    invariant((previous?.tag ?? null) === plan.previousTag && (previous?.sha ?? null) === plan.previousSha, 'Release plan is stale: the previous release tag changed.');
    invariant(nextVersion({ unit, previous, forced: plan.version, now: validationDate, draft: plan.draft, prerelease: plan.prerelease }) === plan.version, 'Recorded release version must remain unchanged.');
    invariant(await this.git.ancestor(plan.sourceSha, head), 'Pinned source is not an ancestor of the managed release head.');
    await this.git.scratch(plan.sourceSha, async worktree => {
      const notes = await this.generatedNotes(worktree, unit, plan);
      invariant(notes === plan.notes, 'Reviewed release notes do not match deterministic source notes.');
      const changes = await this.expectedChanges(worktree, unit, plan);
      const actualFiles = (await this.git.call(['diff', '--no-ext-diff', '--name-only', '-z', plan.sourceSha, head])).split('\0').filter(Boolean);
      invariant(actualFiles.every(file => changes.has(file)), 'Managed release PR changes files outside the generated allowlist.');
      if (mergeSha) {
        const mergedFiles = (await this.git.call(['diff', '--no-ext-diff', '--name-only', '-z', plan.sourceSha, mergeSha])).split('\0').filter(Boolean);
        invariant(mergedFiles.every(file => changes.has(file)), 'Merged release changes files outside the generated allowlist; refresh or inspect merge integrity.');
      }
      for (const [file, content] of changes) {
        invariant(await this.git.file(head, file) === content, `Managed release file differs from its expected content: ${file}`);
        if (mergeSha) invariant(await this.git.file(mergeSha, file) === content, `Merged release file differs from reviewed content: ${file}`);
      }
    });
    if (mergeSha) {
      invariant(await this.git.ancestor(plan.sourceSha, mergeSha), 'Merged release does not contain its pinned source.');
      const parents = (await this.git.call(['rev-list', '--parents', '-n', '1', mergeSha])).trim().split(' ').slice(1);
      invariant(parents[0] === plan.sourceSha, 'Base advanced after preparation, or merge topology is unsupported; refresh before using merge or squash merge.');
      invariant(configDigest(await this.configuration(mergeSha)) === plan.configDigest, 'Merged release config differs from reviewed source config.');
    }
    return { config, unit, branch };
  }

  async loadPlan(head, unit) {
    return parsePlan(await this.git.file(head, statePath(unit)));
  }

  outputs(plan, values = {}) {
    return { unit: plan.unit, version: plan.version, tag: plan.tag, 'source-sha': plan.sourceSha, ...values };
  }

  async check() {
    await this.initialize();
    const head = await this.git.sha('HEAD');
    const config = await this.configuration(head);
    const name = this.env.RELEASE_UNIT || 'release';
    const unit = config.units[name];
    invariant(unit, `Unknown release unit: ${name}`);
    const previous = await this.previous(unit, head);
    const draft = booleanOverride(this.env.RELEASE_DRAFT, unit.draft, 'RELEASE_DRAFT');
    const prerelease = booleanOverride(this.env.RELEASE_PRERELEASE, unit.prerelease, 'RELEASE_PRERELEASE');
    const forced = this.env.RELEASE_VERSION || undefined;
    const bumped = unit.scheme === 'semver' && previous && !forced ? await this.cliff.bumped(this.git.root, unit, previous, head) : undefined;
    const version = nextVersion({ unit, previous, forced, bumped, now: this.clock(), draft, prerelease });
    invariant(!(await this.git.tags()).includes(`${unit.tagPrefix}${version}`), 'Release tag already exists.');
    invariant(forced || await this.hasChanges(unit, previous, head), 'No relevant source changes; set RELEASE_VERSION explicitly to force a release.');
    for (const directory of unit.paths) await safeFile(this.git.root, directory, { directory: true });
    await manifestChanges(this.git.root, unit, version);
    if (unit.changelog !== false) await safeFile(this.git.root, unit.changelog, { missing: true });
    return this.outputs({ unit: name, version, tag: `${unit.tagPrefix}${version}`, sourceSha: head });
  }

  async prepare() {
    await this.initialize(true);
    const { config, sourceSha } = await this.baseConfiguration();
    const name = this.env.RELEASE_UNIT || 'release';
    const unit = config.units[name];
    invariant(unit, `Unknown release unit: ${name}`);
    const previous = await this.previous(unit, sourceSha);
    const draft = booleanOverride(this.env.RELEASE_DRAFT, unit.draft, 'RELEASE_DRAFT');
    const prerelease = booleanOverride(this.env.RELEASE_PRERELEASE, unit.prerelease, 'RELEASE_PRERELEASE');
    const forced = this.env.RELEASE_VERSION || undefined;
    invariant(forced || await this.hasChanges(unit, previous, sourceSha), 'No relevant source changes; set RELEASE_VERSION explicitly to force a release.');
    const bumped = unit.scheme === 'semver' && previous && !forced ? await this.cliff.bumped(this.git.root, unit, previous, sourceSha) : undefined;
    const version = nextVersion({ unit, previous, forced, bumped, now: this.clock(), draft, prerelease });
    const tag = `${unit.tagPrefix}${version}`;
    invariant(!(await this.git.tags()).includes(tag), `Tag ${tag} already exists; releases never overwrite tags.`);
    const branch = releaseBranch(config, name, version);
    const pr = await this.github.findPr(branch, config.baseBranch);
    const oldHead = await this.git.remoteBranch(branch);
    let oldPlan;
    if (oldHead) {
      oldPlan = await this.loadPlan(oldHead, name);
      const validated = await this.validatePlan(oldPlan, oldHead, { pr, trustedBaseSha: sourceSha });
      invariant(validated.branch === branch, 'Existing branch has an unexpected managed release identity.');
      if (pr) { managedPr(pr, { repository: this.repository, branch, base: config.baseBranch, releaseAuthor: config.releaseAuthor, open: true }); invariant(pr.head.sha === oldHead, 'Release PR head changed during preparation.'); }
      else {
        const parents = (await this.git.call(['rev-list', '--parents', '-n', '1', oldHead])).trim().split(' ').slice(1);
        const author = (await this.git.call(['show', '-s', '--format=%an%n%ae%n%B', oldHead])).trim();
        invariant(parents.length === 1 && parents[0] === oldPlan.sourceSha && author === `github-actions[bot]\n41898282+github-actions[bot]@users.noreply.github.com\nchore(release): ${oldPlan.unit} ${oldPlan.version}\n\nSource-SHA: ${oldPlan.sourceSha}`, 'Existing branch without a PR is not a recognizable initial engine commit.');
      }
      invariant(oldPlan.draft === draft && oldPlan.prerelease === prerelease, 'Existing release flags differ; close the PR before preparing another release mode.');
    } else invariant(!pr, 'Release PR exists but its managed branch is missing.');
    const plan = {
      schemaVersion: 1, unit: name, version, tag, sourceSha,
      previousTag: previous?.tag ?? null, previousSha: previous?.sha ?? null,
      configDigest: configDigest(config), releaseDate: oldPlan?.sourceSha === sourceSha ? oldPlan.releaseDate : this.clock().toISOString(),
      draft, prerelease, notes: '',
    };
    return this.refresh({ config, unit, plan, branch, oldHead, oldPlan, pr });
  }

  async refresh({ config, unit, plan, branch, oldHead, oldPlan, pr }) {
    let head = oldHead;
    await this.git.scratch(plan.sourceSha, async worktree => {
      plan.notes = await this.generatedNotes(worktree, unit, plan);
      const changes = await this.expectedChanges(worktree, unit, plan);
      if (oldPlan && JSON.stringify(oldPlan) === JSON.stringify(plan)) return;
      for (const file of changes.keys()) {
        await safeFile(worktree.root, file, { missing: true });
        await mkdir(path.dirname(path.join(worktree.root, file)), { recursive: true });
      }
      await writeChanges(worktree.root, changes);
      head = await worktree.commit([...changes.keys()], plan, oldHead);
    });
    if (head !== oldHead) {
      await this.git.call(['push', `--force-with-lease=refs/heads/${branch}:${oldHead ?? ''}`, 'origin', `${head}:refs/heads/${branch}`]);
    }
    const body = { title: `chore(release): ${plan.unit} ${plan.version}`, body: prBody(plan) };
    let releasePr;
    if (pr) {
      // Refresh metadata even after an identical-source retry of a failed API update.
      releasePr = pr.body === body.body && pr.title === body.title ? pr : await this.github.api(`repos/${this.repository}/pulls/${pr.number}`, { method: 'PATCH', body });
    } else {
      releasePr = await this.github.api(`repos/${this.repository}/pulls`, { method: 'POST', body: { ...body, head: branch, base: config.baseBranch } });
    }
    invariant(Number.isSafeInteger(releasePr.number), 'GitHub did not return a release PR number.');
    managedPr(releasePr, { repository: this.repository, branch, base: config.baseBranch, releaseAuthor: config.releaseAuthor, open: true });
    invariant(releasePr.head.sha === head && releasePr.body === body.body, 'GitHub returned unexpected managed release PR content or head.');
    return this.outputs(plan, { 'pr-number': String(releasePr.number) });
  }

  async event() {
    invariant(this.env.GITHUB_EVENT_PATH && path.isAbsolute(this.env.GITHUB_EVENT_PATH), 'Set GITHUB_EVENT_PATH to the GitHub event JSON file.');
    let event;
    try { event = JSON.parse(await readFile(this.env.GITHUB_EVENT_PATH, 'utf8')); } catch { invariant(false, 'Cannot read GitHub event JSON.'); }
    invariant(event.repository?.full_name === this.repository, 'Event repository does not match GITHUB_REPOSITORY.');
    return event;
  }

  async update() {
    const event = await this.event();
    if (event.action !== 'created' || !event.issue?.pull_request || event.comment?.body !== '@datarose-release update') return {};
    await this.initialize(true);
    const pr = await this.github.pr(event.issue.number);
    const name = managedUnit(pr.body);
    if (!name) return {};
    invariant(['write', 'maintain', 'admin'].includes(await this.github.permission(event.comment.user?.login)), 'Only collaborators with write, maintain, or admin permission can refresh releases.');
    const { config, sourceSha } = await this.baseConfiguration();
    const oldHead = await this.git.remoteBranch(pr.head?.ref);
    invariant(oldHead && oldHead === pr.head.sha, 'Release PR head changed before refresh.');
    const oldPlan = await this.loadPlan(oldHead, name);
    const validated = await this.validatePlan(oldPlan, oldHead, { pr, trustedBaseSha: sourceSha });
    managedPr(pr, { repository: this.repository, branch: validated.branch, base: validated.config.baseBranch, releaseAuthor: config.releaseAuthor, open: true });
    const unit = config.units[name];
    invariant(unit && config.baseBranch === validated.config.baseBranch, 'Release unit or base changed; prepare a new release PR.');
    const previous = await this.previous(unit, sourceSha);
    invariant((previous?.tag ?? null) === oldPlan.previousTag && (previous?.sha ?? null) === oldPlan.previousSha, 'A newer release exists; prepare a new release PR.');
    nextVersion({ unit, previous, forced: oldPlan.version, now: this.clock(), draft: oldPlan.draft, prerelease: oldPlan.prerelease });
    invariant(await this.git.ancestor(oldPlan.sourceSha, sourceSha), 'Base history no longer contains the pinned release source.');
    const branch = releaseBranch(config, name, oldPlan.version);
    invariant(branch === validated.branch && `${unit.tagPrefix}${oldPlan.version}` === oldPlan.tag, 'Release branch or tag settings changed; prepare a new release PR.');
    const plan = { ...oldPlan, sourceSha, configDigest: configDigest(config), releaseDate: sourceSha === oldPlan.sourceSha ? oldPlan.releaseDate : this.clock().toISOString() };
    return this.refresh({ config, unit, plan, branch, oldHead, oldPlan, pr });
  }

  async publish() {
    const event = await this.event();
    if (event.action !== 'closed' || event.pull_request?.merged !== true) return {};
    await this.initialize(true);
    const pr = await this.github.pr(event.pull_request.number ?? event.number);
    const name = managedUnit(pr.body);
    if (!name) return {};
    invariant(isSha(pr.head?.sha) && isSha(pr.merge_commit_sha), 'GitHub returned invalid release commit metadata.');
    const { sourceSha: trustedBaseSha } = await this.baseConfiguration();
    await this.git.call(['fetch', '--no-tags', 'origin', `refs/pull/${pr.number}/head`]);
    const head = await this.git.sha('FETCH_HEAD');
    invariant(head === pr.head.sha, 'Fetched release PR head does not match GitHub metadata.');
    const plan = await this.loadPlan(head, name);
    const mergeSha = pr.merge_commit_sha;
    const validated = await this.validatePlan(plan, head, { mergeSha, pr, trustedBaseSha, exactBody: true });
    const base = await this.git.sha(`refs/remotes/origin/${validated.config.baseBranch}`);
    invariant(await this.git.ancestor(mergeSha, base), 'Release merge is not in the configured base branch.');
    const tags = await this.git.tags();
    if (tags.includes(plan.tag)) {
      invariant(await this.git.sha(`refs/tags/${plan.tag}`) === mergeSha, 'Release tag already exists on a different commit; never overwrite it.');
    } else {
      await this.git.call(['tag', plan.tag, mergeSha]);
    }
    const remoteTag = await this.git.remoteTag(plan.tag);
    invariant(!remoteTag || remoteTag === mergeSha, 'Remote release tag already exists on a different commit; never overwrite it.');
    if (!remoteTag) await this.git.call(['push', 'origin', `refs/tags/${plan.tag}:refs/tags/${plan.tag}`]);
    let release;
    if (validated.unit.githubRelease) {
      release = await this.github.release(plan.tag);
      if (!release) {
        release = await this.github.api(`repos/${this.repository}/releases`, {
          method: 'POST', body: { tag_name: plan.tag, target_commitish: mergeSha, name: plan.tag, body: plan.notes, draft: plan.draft, prerelease: plan.prerelease },
        });
      }
      invariant(release.tag_name === plan.tag && release.target_commitish === mergeSha && release.body === plan.notes && release.draft === plan.draft && release.prerelease === plan.prerelease, 'Existing GitHub Release differs from reviewed notes, flags, or tag target; inspect it manually.');
      invariant(Number.isSafeInteger(release.id) && typeof release.html_url === 'string', 'GitHub returned invalid release metadata.');
    }
    return this.outputs(plan, {
      'release-sha': mergeSha, 'pr-number': String(pr.number),
      ...(release ? { 'release-id': String(release.id), 'release-url': release.html_url } : {}),
    });
  }
}
