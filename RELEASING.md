# Releasing OpenCode Goals

This project separates **release readiness** from **publishing**. Pull-request CI proves an exact commit is packageable; npm publication is performed only by the repository's trusted-publishing workflow after the release version reaches `main`.

## Required release gates

Before a stable release reaches `main`, the exact pull-request head should have these workflows green:

- `CI`
- `Actions Security Gate`
- `Real Host Progress`
- `Real Restart Recovery`
- `Release Readiness`
- `Experimental OpenCode 2 Host`
- `Current OpenCode 2 Stable Host`
- `OpenCode 2 Todo Materialization Diff`
- `OpenCode 2 Unit Handoff`

`CI` exercises the minimum supported OpenCode compatibility target, the current published OpenCode plugin SDK, and real OpenCode lifecycle/semantic/steering/Todo canaries.

`Release Readiness` runs on Ubuntu and Windows with Node 20 and Node 24. It runs checks/tests/evals, builds the npm tarball, installs it into a clean production-only consumer without manually injecting runtime dependencies, imports the public API plus dedicated server/TUI entrypoints, and executes the packed installer artifact.

`Experimental OpenCode 2 Host` is the historical workflow name for the pinned OpenCode 2.0.11 parity matrix. It exercises the exact-host server entry, lifecycle authority, autonomous ownership, control plane, telemetry/accounting, semantic completion, verifier boundaries, provider recovery, and related V2 canaries. The workflow name is retained so existing required-check configuration stays stable.

`Current OpenCode 2 Stable Host` separately proves that the default lifecycle/autonomous path still works on the current stable host pin. `OpenCode 2 Todo Materialization Diff` compares stock and Goal tool exposure on the same current host so a Goal regression cannot be confused with an upstream tool-surface change.

`OpenCode 2 Unit Handoff` proves opt-in bounded per-unit rotation on current OpenCode 2.0.16: one durable Goal crosses three native sessions through the two-phase handoff and reaches ordinary host + semantic-verifier completion without resetting budget/evidence/usage.

For installer releases, package smoke must verify all of these from the packed artifact:

```text
@bybrawe/opencode-goal
@bybrawe/opencode-goal/server
@bybrawe/opencode-goal/tui
@opencode-ai/plugin runtime dependency
opencode-goal --version
installer exact package pin
OpenCode 1 managed commands/goal.md creation
OpenCode 2 native plugins config / plugin-native command mode
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
5. Confirm `@bybrawe/opencode-goal/server` default-exports exactly one dual OpenCode plugin module with callable `server` and `setup` functions; V1 uses `server`, while stable V2 uses `setup` by default with explicit fail-closed environment kill switches.
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
1.3.38
```

Before `npm publish`, the workflow:

1. runs the Actions security policy;
2. verifies the trusted-publishing npm runtime;
3. checks that `package.json` equals the expected one-shot version;
4. checks the npm registry and skips publication if the exact version already exists while still running registry/installer verification;
5. when publication is still needed, requires the predecessor release (`1.3.37`) to exist and remain authoritative as npm `latest` with the expected installer bin before allowing `1.3.38` to publish.

Publication uses npm Trusted Publishing/OIDC under the `latest` tag; no long-lived npm token is stored in the workflow.

## After publishing

The workflow itself must verify all of these before the release is considered published:

- the exact `1.3.38` package version is visible in the npm registry;
- npm `latest` resolves to `1.3.38`;
- `bin.opencode-goal` resolves to the expected `bin/opencode-goal.js` path;
- a clean consumer can run `npm exec --yes --package=@bybrawe/opencode-goal@1.3.38 -- opencode-goal --version` and receives `1.3.38`.

Then, from a clean config directory, run the public installer and verify:

- the plugin entry is pinned to the published exact version in every supported global config file that already exists;
- the published package exposes a valid dedicated `./server` entrypoint;
- the package carries its required `@opencode-ai/plugin` runtime dependency;
- on OpenCode 1, `commands/goal.md` is created and recognized by OpenCode command discovery; on OpenCode 2, the installer writes the native `plugins` entry and removes only the Goal-owned legacy command bridge;
- `/goal` is visible after a full OpenCode restart;
- `/goal status` and `/goal <objective>` are handled by the correct host surface: V1 plugin interception ahead of the managed bridge, or the plugin-native V2 `/goal` command;
- `--uninstall` removes Goal-owned registration/command artifacts without deleting unrelated config or project Goal state.

Do not claim a release is published merely because the merge or publish workflow started; the npm registry plus the clean-consumer installer check are the final publication source of truth.
