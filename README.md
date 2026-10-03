# datarose-dev/release

`datarose-dev/release` prepares reviewed release pull requests and publishes their merged tags and GitHub releases. It supports solo repositories, shared-version monorepos, and independent release units.

The tool does not build packages, publish to registries, rewrite internal dependency constraints, or run consumer-defined build commands. Consumers own builds and release asset uploads.

## Quick start

1. Add `.release.json` at the repository root. Start with [the configuration example](.release.json) or copy one from [`examples/`](examples/).
2. Save [`examples/consumer-workflow.yml`](examples/consumer-workflow.yml) as `.github/workflows/release.yml` in your repository.
3. Replace every `REPLACE_WITH_40_CHARACTER_SHA` placeholder with the same full commit SHA from `datarose-dev/release`. The template has three reusable-workflow refs and three matching `tool-ref` inputs. These are placeholders, not released versions.
4. Enable Actions to create pull requests in repository settings. Set workflow permissions to allow the release jobs' requested contents and pull-request writes.
5. Commit the workflow to the default branch. GitHub requires the workflow file on the default branch for `workflow_dispatch`, `issue_comment`, and `pull_request_target`.
6. Run the workflow manually and review the generated release pull request before merging.

Start a release with GitHub CLI:

```sh
gh workflow run release.yml --repo OWNER/REPO -f unit=release
gh workflow run release.yml --repo OWNER/REPO -f unit=release -f version=2026.10.1
```

The second command forces the specified version exactly; the engine does not add a suffix or otherwise change it. For a CalVer unit, the forced version must match the current UTC year and month and advance its previous tag.

Pin the reusable workflow ref and `tool-ref` to the **same immutable full SHA**. The reusable workflow validates `tool-ref` before checkout. It checks out the release tool into `release-tool` and the target repository's default branch into `release-target`, with full history and tags. Release workflows run on hosted Linux x86_64 runners with Node.js 22.

## Release lifecycle

1. `prepare` selects a version and writes release state and reviewed notes. It opens a release pull request from `chore/datarose-release-automatization-for-vVERSION`; independent units include their unit name in the branch.
2. Review and merge that pull request. Tags point to the merged release commit. The original reviewed source SHA remains separate in `.datarose-release/<unit>.json`.
3. `publish` creates the tag and, when configured, a GitHub release whose notes are the exact reviewed section saved during preparation.
4. To refresh an open release pull request, post the exact comment `@datarose-release update` on that pull request. The helper checks actor authorization and pull-request context; the workflow also filters to created comments with that exact body and PR context.

The refresh uses the latest configured base branch and preserves the selected version. Comment-triggered workflows never check out or execute commented pull-request code. The merge workflow uses `pull_request_target` only to access trusted workflow code and release metadata; it checks out the target default branch, never the PR head or merge ref.

For independent units, refresh and publication infer unit from managed release PR state; default `RELEASE_UNIT=release` does not select a different unit. Refresh the release PR after new commits reach its configured base. Publication rejects a release if the base advances after the reviewed snapshot. Refresh immediately before merging when the base changed. Merge commits and squash merges are supported; rebase merges are not.

Publication and retry use the preparation date recorded in the reviewed plan. This allows retries after a UTC month boundary and replay after a newer tag exists. New CalVer allocations and refreshes still require the current UTC month. If an open CalVer PR becomes stale at month change, its original version cannot be preserved by comment update; close it and prepare a new PR with a current version. A stale, already-merged PR cannot be repaired by comment update; prepare a fresh release PR. Do not weaken merge or tag integrity checks.

This repository's own release workflow defaults to unit `release`. Its `workflow_dispatch` inputs are `unit`, optional forced `version`, `draft`, and `prerelease`. Empty `draft` or `prerelease` values use the unit configuration. The wrapper passes `github.sha` for dispatch and comment runs, and the trusted pull-request base SHA for merge publication. It never passes the PR head or merge SHA as the tool ref.

## Configuration

Release configuration uses JSON. `.release.json` is the default; pass another JSON path through the reusable workflow's `config` input. `$schema` is optional. YAML is supported as a manifest format, not as release configuration.

```json
{
  "baseBranch": "master",
  "releaseAuthor": "github-actions[bot]",
  "units": {
    "release": {
      "scheme": "calver",
      "paths": ["."],
      "tagPrefix": "v",
      "initialVersion": "0.1.0",
      "changelog": "CHANGELOG.md",
      "githubRelease": true,
      "draft": false,
      "prerelease": false,
      "manifests": [
        { "path": "package.json", "format": "json", "key": ["version"] }
      ]
    }
  }
}
```

- `baseBranch` selects the branch used to prepare or refresh release changes.
- `releaseAuthor` binds managed release PRs to one exact GitHub login. It defaults to `github-actions[bot]`. Set it to the exact PR author login for a PAT or GitHub App token.
- `units` maps unit names to versioning, paths, tags, changelog, GitHub release, and manifest settings.
- `scheme` is `calver` or `semver`. CalVer uses UTC `YEAR.MONTH.counter`, with an unpadded month and counter starting at 1 each month. SemVer increments from `initialVersion` using Conventional Commits.
- `paths` scopes change detection. Use `["."]` for a solo repository or shared-version release.
- `tagPrefix` prefixes generated versions, such as `v`, `js/v`, or `core/v`.
- `initialVersion` seeds version calculation when no earlier unit tag exists.
- `changelog: false` skips the changelog file. Reviewed notes are still saved in release state.
- `githubRelease: false` creates the tag and, when enabled, the changelog without a GitHub release.
- `draft` and `prerelease` accept booleans. Workflow inputs can override each with `true`, `false`, or an empty value to keep the configured setting.
- Draft is GitHub release metadata; it does not change the version. `prerelease: true` may append `-rc.1` to an automatically calculated stable version. It never modifies a forced version.
- `manifests` updates existing version fields in supported JSON, YAML, and TOML manifests. TOML keys use path components, for example `["workspace", "package", "version"]`.

See [`examples/independent-units/`](examples/independent-units/) for separate JavaScript and Rust release units with different path scopes and tag prefixes. See [`examples/shared-version-monorepo/`](examples/shared-version-monorepo/) for one version shared by JavaScript, PHP, and a Cargo workspace.

First-version lockfile support is limited. The root npm `package-lock.json` v2/v3 is synchronized when it matches root `package.json`; independent nested npm packages under a parent workspace lockfile are rejected. `yarn.lock`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`, `Cargo.lock`, and `composer.lock` are unsupported; the engine stops instead of rewriting them. TOML edits require an existing string field in a regular table. Inline, dotted, quoted, multiline, or ambiguous TOML fields are unsupported. YAML version fields must be existing unanchored string scalars; aliases, merge mappings, custom tags, and multiline scalars are unsupported.

## Permissions and security

- CI runs with `contents: read`, checks out source without persisted credentials, and uses the pinned setup composite to install dependencies without lifecycle scripts and install verified git-cliff.
- Release jobs request only `contents: write` and `pull-requests: write` for preparation, or `contents: write` and `pull-requests: read` for publication. They install and execute the trusted tool checkout, not target-repository scripts.
- `actions/checkout` and `actions/setup-node` use immutable commit pins. The setup action installs pinned npm dependencies with `npm ci --ignore-scripts` and verifies the git-cliff 2.14.2 archive SHA-256 before adding it to `PATH`.
- The helper receives values through environment variables. Workflows do not interpolate comment text, versions, or unit names into shell commands. No workflow input accepts a build command or hook string.
- `GITHUB_TOKEN` cannot trigger most new workflow runs after it creates a pull request. The optional `release-token` secret lets maintainers provide a PAT or GitHub App token when downstream CI must run. Its PR author login must exactly match configured `releaseAuthor`; the helper does not infer author identity from the PR. Without this secret, the workflow token uses default author `github-actions[bot]`.
- GitHub requires the repository setting **Allow GitHub Actions to create and approve pull requests** for `GITHUB_TOKEN`-based PR creation. Branch protection and organization policy must also allow the release bot to push its release branch and open PRs.

Do not pass a write token to consumer build jobs. The consumer workflow template includes a read-only build job pinned to `needs.publish.outputs.release-sha`, followed by a separate `contents: write` upload job. Add your repository's existing build and artifact-transfer steps at the marked placeholders; no artifact action is bundled. Upload uses `gh release upload "$RELEASE_TAG" dist/* --repo "$GITHUB_REPOSITORY" --clobber`, with `RELEASE_TAG` from the publish output. Skip upload when `release-id` is empty. Draft releases allow assets to be added before publication.

Reusable workflows expose `unit`, `version`, `tag`, `source-sha`, `release-sha`, `pr-number`, `release-id`, and `release-url`. `release-sha` identifies the merged commit for build checkout; `source-sha` identifies the reviewed source. A tag-only unit can have empty release ID and URL.

## Development

Requirements: Node.js 22 and npm.

```sh
npm ci --ignore-scripts
node --test
```

Run the helper's read-only check from a clean checkout of this repository after installing dependencies. Target worktree must contain no uncommitted or untracked files. For SemVer units with a previous tag, put the pinned git-cliff binary on `PATH`:

```sh
RELEASE_REPOSITORY_DIR="$PWD" RELEASE_UNIT=release node src/cli.mjs check
```

`check` validates release configuration, candidate version, relevant changes, manifest fields, and changelog path. It does not prepare or publish a release.

CI sets `REQUIRE_GIT_CLIFF=1` and runs tests with the real verified git-cliff binary; CI fails if binary is missing. Locally, real-binary tests skip when git-cliff is unavailable. No live remote release was run for this implementation. A maintainer must verify release behavior with an integration test in a disposable repository.

## License

Licensed under the GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
