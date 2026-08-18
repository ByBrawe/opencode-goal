# Releasing OpenCode Goals

This project separates **release readiness** from **publishing**. Pull-request CI proves an exact commit is packageable; npm publication is performed only by the repository's trusted-publishing workflow after the release version reaches `main`.

## Required release gates

Before a stable release reaches `main`, the exact pull-request head should have these workflows green:

- `CI`
- `Actions Security Gate`
- `Real Host Progress`
- `Real Restart Recovery`
- `Release Readiness`

`CI` exercises the minimum supported OpenCode compatibility target, the current published OpenCode plugin SDK, and real OpenCode lifecycle/semantic/steering/Todo canaries.

`Release Readiness` runs on Ubuntu and Windows with Node 20 and Node 24. It runs checks/tests/evals, builds the npm tarball, installs it into a clean production-only consumer without manually injecting runtime dependencies, imports the public API plus dedicated server/TUI entrypoints, and executes the packed installer artifact.

For installer releases, package smoke must verify all of these from the packed artifact:

```text
@bybrawe/opencode-goal
@bybrawe/opencode-goal/server
@bybrawe/opencode-goal/tui
@opencode-ai/plugin runtime dependency
opencode-goal --version
installer exact package pin
managed commands/goal.md creation
--uninstall package registration removal
--uninstall managed command removal
```

The dedicated `./server` entrypoint is required because current OpenCode resolves that export before falling back to legacy root-module export scanning. The public root barrel intentionally exposes programmatic helpers and must not be used as the server plugin module.

Local equivalent:

```text
npm install
npm run release:check
```

Machine-readable package smoke:

```text
npm run package:smoke -- --json package-smoke-report.json
```

## Preparing a stable release

1. Keep release work on a pull request until all required gates are green on the exact head commit.
2. Align `package.json`, `CHANGELOG.md`, README/release documentation, benchmark pins when applicable, and `.github/workflows/publish-npm.yml`.
3. Confirm every module imported by the compiled npm plugin at runtime is declared in production `dependencies`; do not rely on a peer/dev-only package being present in OpenCode's isolated plugin cache.
4. Confirm `engines.opencode` declares the supported host range.
5. Confirm `@bybrawe/opencode-goal/server` default-exports exactly one OpenCode plugin module with a callable `server` function.
6. Confirm npm Trusted Publishing is authorized for this repository/workflow and package.
7. Inspect package-smoke evidence and `npm pack --dry-run` output.
8. For installer releases, verify install/update and `--uninstall` against an isolated config directory.
9. Verify the installer does not overwrite a user-owned `commands/goal.md` and uninstall does not remove user-owned command files or project Goal state.
10. If more than one supported global OpenCode config filename exists, verify install/update stages every config first and then pins the same exact Goal package version in all of them so a later-loaded config cannot shadow the plugin registration.
11. Merge only the green exact head.

## Trusted stable publication

`.github/workflows/publish-npm.yml` is the only workflow allowed `id-token: write`. It uses pinned release actions, `contents: read`, and checkout with persisted credentials disabled.

The current one-shot stable guard is:

```text
1.3.19
```

Before `npm publish`, the workflow:

1. runs the Actions security policy;
2. verifies the trusted-publishing npm runtime;
3. checks that `package.json` equals the expected one-shot version;
4. checks the npm registry and skips if the exact version already exists.

Publication uses npm Trusted Publishing/OIDC under the `latest` tag; no long-lived npm token is stored in the workflow.

## After publishing

Verify the registry shows the exact version. From a clean config directory, run the public installer and verify:

- the plugin entry is pinned to the published exact version in every supported global config file that already exists;
- the published package exposes a valid dedicated `./server` entrypoint;
- the package carries its required `@opencode-ai/plugin` runtime dependency;
- `commands/goal.md` is created and recognized by OpenCode command discovery;
- `/goal` is visible after a full OpenCode restart;
- `/goal status` and `/goal <objective>` are intercepted by the plugin rather than reaching the managed command bridge fallback;
- `--uninstall` removes Goal-owned registration/command artifacts without deleting unrelated config or project Goal state.

Do not claim a release is published merely because the merge or publish workflow started; the npm registry is the final publication source of truth.