import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { invariant } from './errors.mjs';
import { run } from './runner.mjs';

export const toolRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const regexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function cliffArguments(root, unit, previous, sourceSha) {
  const args = ['--config', path.join(toolRoot, 'cliff.toml'), '--repository', root, '--offline', '--no-exec', '--use-branch-tags', '--tag-pattern', `^${regexEscape(unit.tagPrefix)}[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`];
  for (const directory of unit.paths) args.push('--include-path', directory === '.' ? '**' : `${directory}/**`);
  args.push('--', previous ? `${previous.sha}..${sourceSha}` : sourceSha);
  return args;
}

export class Cliff {
  constructor(runner = run, env = process.env) {
    this.runner = runner;
    // Consumer environment must not enable remote metadata, custom templates, or output files.
    this.env = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_CLIFF_') && !['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITLAB_TOKEN', 'GITEA_TOKEN', 'BITBUCKET_TOKEN', 'AZURE_DEVOPS_TOKEN'].includes(key)));
  }

  async bumped(root, unit, previous, sourceSha) {
    const args = cliffArguments(root, unit, previous, sourceSha);
    args.splice(args.indexOf('--'), 0, '--bumped-version');
    return (await this.runner('git-cliff', args, { cwd: root, env: this.env })).trim();
  }

  async notes(root, unit, plan) {
    const previous = plan.previousTag ? { sha: plan.previousSha } : null;
    const args = cliffArguments(root, unit, previous, plan.sourceSha);
    args.splice(args.indexOf('--'), 0, '--context', '--tag', plan.tag);
    const raw = await this.runner('git-cliff', args, { cwd: root, env: this.env });
    let contexts;
    try { contexts = JSON.parse(raw); } catch { invariant(false, 'git-cliff returned invalid changelog context.'); }
    invariant(Array.isArray(contexts) && contexts.length > 0, 'git-cliff returned no changelog context.');
    const context = {
      ...contexts[0], version: plan.version,
      timestamp: Math.floor(new Date(plan.releaseDate).getTime() / 1000),
      commits: contexts.flatMap(item => item.commits ?? []),
    };
    invariant(context.commits.length > 0, 'No relevant commits for release notes.');
    const directory = await mkdtemp(path.join(root, '.git-cliff-context-'));
    try {
      const file = path.join(directory, 'context.json');
      await writeFile(file, JSON.stringify([context]));
      const text = await this.runner('git-cliff', ['--config', path.join(toolRoot, 'cliff.toml'), '--from-context', file, '--strip', 'header', '--offline', '--no-exec'], { cwd: root, env: this.env });
      const notes = text.replace(/\r\n/gu, '\n').trim() + '\n';
      invariant(notes.startsWith(`## [${plan.version}] - ${plan.releaseDate.slice(0, 10)}\n`), 'git-cliff generated an unexpected release heading.');
      return notes;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

export function prBody(plan) {
  return `<!-- datarose-release:${plan.unit} -->\nRelease ${plan.unit} ${plan.version}.\n\nSource SHA: \`${plan.sourceSha}\`\nPrevious tag: ${plan.previousTag ? `\`${plan.previousTag}\`` : 'none (first release)'}\n\nReview the version files and notes before merging. After new commits reach the base branch, a collaborator with write, maintain, or admin permission can comment exactly:\n\n\`@datarose-release update\`\n\nThe version stays unchanged during refresh. The tag will target the merged release commit, not the source SHA.\n\n<!-- datarose-release-notes:start -->\n${plan.notes}<!-- datarose-release-notes:end -->\n`;
}
