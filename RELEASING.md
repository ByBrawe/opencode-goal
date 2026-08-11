# Releasing OpenCode Goals

This project intentionally separates **release readiness** from **publishing**. Pull-request CI proves that an exact commit is packageable; npm publication is performed only by the repository's narrowly scoped trusted-publishing workflow after a release-version change reaches `main`.

## Automated release gate

Before a stable release can reach `main`, the exact pull-request head should have all repository workflows green, including:

- `CI`
- `Actions Security Gate`
- `Real Host Progress`
- `Real Restart Recovery`
- `Release Readiness`

`CI` also exercises the minimum supported `@opencode-ai/plugin` peer and the current published plugin version, plus real OpenCode lifecycle/semantic/steering canaries on Ubuntu and Windows.

`Release Readiness` runs on Ubuntu and Windows with Node 20 and Node 24. Each matrix job runs TypeScript checks, the product unit/regression suite, the mandatory adversarial eval corpus, then builds the npm tarball, installs that tarball into a clean temporary consumer project, and imports both public package entrypoints:

```text
@bybrawe/opencode-goal
@bybrawe/opencode-goal/tui
```

The package smoke test also rejects tarballs that are missing required package/documentation/build files and rejects accidental publication of source/tests/scripts/workflow/eval files.

Local equivalent:

```text
npm install
npm run release:check
```

For a machine-readable tarball report:

```text
npm run package:smoke -- --json package-smoke-report.json
```

## Preparing a stable release

1. Keep the release work on a pull request until every required repository gate is green on the exact head commit.
2. Update `package.json`, `README.md`, `CHANGELOG.md`, benchmark examples/docs, and `.github/workflows/publish-npm.yml` so they all name the same one-shot stable version.
3. Keep `main` protected (or use an equivalent repository ruleset) so required checks cannot be bypassed by an accidental force push or unreviewed direct release change.
4. Confirm npm Trusted Publishing is authorized for the repository/workflow and the `@bybrawe/opencode-goal` package.
5. Inspect the release-readiness package-smoke evidence and `npm pack --dry-run` output before merging.
6. Merge the green release pull request. Ordinary pull-request CI never publishes.

The package declares `publishConfig.access = public`, so the scoped package is intentionally public.

## Trusted stable publication

`.github/workflows/publish-npm.yml` is the only workflow allowed `id-token: write`. It uses pinned release actions, `contents: read`, and checkout with persisted credentials disabled.

The workflow is triggered by relevant changes reaching `main` (or by an explicit workflow dispatch), but publishing is guarded by an exact one-shot version check. For the current release candidate that guard is:

```text
1.3.0
```

Before installing release dependencies or invoking `npm publish`, the workflow:

1. runs the repository Actions security policy;
2. verifies the trusted-publishing npm runtime;
3. compares `package.json` to the expected one-shot version;
4. checks the npm registry and skips if that exact version already exists.

If all checks allow publication, it publishes with npm Trusted Publishing/OIDC under the `latest` tag. No long-lived npm token is stored in the workflow.

## After publishing

Verify the registry shows the exact version and that a clean project can install/import the published server and TUI entrypoints. Also verify OpenCode can load the published package by its npm name. Do not claim a release is published merely because the merge or publish workflow started; use the registry result as the final source of truth.
