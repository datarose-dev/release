# Repository guide

## Ownership map

- `src/`: release engine and CLI (`prepare`, `update`, `publish`, `check`).
- `test/`: built-in Node.js tests. Run with `node --test`.
- `release.schema.json`: configuration schema; keep it aligned with engine validation and README examples.
- `.release.json`: this repository's CalVer release unit and root `package.json` version manifest.
- `.github/workflows/`: trusted reusable workflows, this repository's release wrapper, and read-only CI.
- `.github/actions/setup/`: pinned Node setup, lifecycle-script-free dependency install, and verified git-cliff installation.
- `examples/`: configuration examples and workflow templates. Keep manifest paths and version fields consistent.
- `README.md`: user setup, configuration, permissions, limits, and release usage.

## Workflow security invariants

- Keep trusted tool checkout separate from target checkout. Validate `tool-ref` as a full 40-character commit SHA before checking it out.
- Never execute target-repository scripts in privileged release jobs. Never check out an issue-comment PR head or merge ref as code.
- Use `pull_request_target` only for merged release metadata and trusted tool execution. Use target default branch with full history and tags.
- Keep checkout credentials disabled. Run `gh auth setup-git` only in release jobs that need authenticated pushes.
- Keep CI read-only and release permissions job-scoped. Do not expose write tokens to build jobs.
- Pass untrusted values through environment variables. Do not interpolate user text or workflow inputs into shell source.
- Do not add arbitrary build commands, hook strings, or unapproved external actions.
- Serialize prepare, update, and publish by repository and configuration path. Keep `cancel-in-progress: false`.
- Preserve published tags on merged release commits and record reviewed source SHA separately.

## Maintenance

- Do not add dependencies without maintainer approval. Use npm and Node's built-in test runner; do not add Python.
- Pin approved Actions to immutable commit SHAs. When updating git-cliff, verify upstream release archive and SHA-256 before changing the pinned version and digest together.
- Keep `actions/checkout` and `actions/setup-node` commit pins and version comments in sync.
- Keep CI on the setup composite with read-only token and `REQUIRE_GIT_CLIFF=1`; do not let mandatory real-binary tests skip in CI.
- Verify workflow examples, JSON release configs, and JSON/TOML/YAML manifest examples against `release.schema.json` and actual manifest files.
- Run `npm ci --ignore-scripts` and `node --test` for engine validation. Validate workflow YAML and example configuration when changing workflow or documentation files.
- Do not claim remote release integration is tested without a successful observed run in a disposable repository.

## Release behavior

- CalVer is UTC `YEAR.MONTH.counter`, month is unpadded, counter starts at 1 each month.
- SemVer follows Conventional Commits and configured `initialVersion`.
- Reviewed release notes persist even when changelog-file writing is disabled. GitHub release body must match reviewed notes.
- Bind managed PR authors to configured `releaseAuthor`; PAT/App PR author login must match exactly. Preserve reviewed version and preparation date for historical publication retries; new CalVer allocations and refreshes use current UTC month.
- JSON/TOML edits must preserve unrelated content. Reject unsupported structures instead of silently rewriting them.
- No internal dependency constraint rewriting, package registry publishing, or automatic builds.
