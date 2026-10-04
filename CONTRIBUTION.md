# Contributing

## Requirements

- Node.js 22 or later and npm.
- The repository uses npm and Node's built-in test runner. Do not add Python or dependencies without maintainer approval.

Install dependencies without running lifecycle scripts:

```sh
npm ci --ignore-scripts
```

## Validate changes

Run the test suite:

```sh
npm test
```

The package script runs `node --test`. Run `npm run check` for a JavaScript syntax check of `src/cli.mjs`; this is not the release engine's read-only `check` command.

Run the read-only release check from a clean checkout after installing dependencies. The target worktree must have no uncommitted or untracked files:

```sh
RELEASE_REPOSITORY_DIR="$PWD" RELEASE_UNIT=release node src/cli.mjs check
```

This CLI check validates release configuration, candidate version, relevant changes, manifest fields, and changelog path. It does not prepare or publish a release. For a SemVer unit with a previous tag, the pinned git-cliff binary must be on `PATH` to calculate the candidate version.

CI installs verified git-cliff 2.14.2 and sets `REQUIRE_GIT_CLIFF=1`, so it fails if the binary is missing. Locally, real-binary tests run when `git-cliff` is on `PATH` and skip otherwise.

## Integration testing and maintenance

No live remote release test has been run for this project. Test release behavior in a disposable GitHub repository; do not use a production repository for first-time smoke tests.

Follow [AGENTS.md](AGENTS.md) for maintainer rules, including immutable Action pins, git-cliff archive and digest updates, and documentation or workflow validation. Do not claim remote release integration is tested without a successful run in a disposable repository.
