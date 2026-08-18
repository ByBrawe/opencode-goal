# Changelog

All notable changes to **OpenCode Goals** are documented here.

## 1.3.17 — 2026-08-18

Shell-heavy Goal progress and diagnostics release.

- Count completed Goal-owned `bash` tool calls as host-observed activity for the no-progress guard without turning shell activity into completion evidence.
- Bind shell activity to the active Goal ID and revision, reject stale completions after Goal edits, deduplicate identical normalized commands by SHA-256, and never persist raw command text in progress notes.
- Add active Goal session-lease diagnostics plus same-project parallel-session isolation coverage.
- Add a deterministic real-OpenCode shell-progress canary on Ubuntu and Windows; stable V1 completion/verifier requirements remain unchanged.

## 1.3.16 — 2026-08-14

Active steering and long-running verification release.

- Keep ordinary user steering inside an active Goal instead of pausing it: preempt only the in-flight autonomous turn, run the queued user message first, and resume autonomous Goal continuation afterward.
- Reject completion/check/verifier results that became stale because newer user steering arrived.
- Raise configured Goal-check default timeout to 60 minutes with an environment override, and raise the effective semantic-verifier default to five minutes while preserving explicit/environment overrides.
- Add isolated experimental OpenCode 2 adapter/request-hook host canaries and daily compatibility checks without changing the stable V1 support contract.
- Add Turkish README coverage and a README language switcher.

## 1.3.15 — 2026-08-13

Lifecycle UX and verifier transport reliability release.

- Surface actionable Goal lifecycle conflict, pause, and resume guidance instead of opaque failures.
- Prefer the supported bounded synchronous session-prompt transport for semantic verification when available while retaining compatibility fallback behavior.
- Improve npm package discoverability metadata and Goal workflow documentation.

## 1.3.14 — 2026-08-12

Multi-turn process-integrity and budget-boundary release.

- Enforce explicit multi-turn/per-turn process requirements using current-revision host runtime evidence rather than trusting a final-state verifier claim alone.
- Treat mutation cadence as distinct-turn proof and reject same-turn batching for objectives that explicitly require separate Goal turns.
- Add real 10-turn completion and same-turn batch-rejection host canaries.
- Settle reached Goal budgets at turn boundaries and enforce reached limits before autonomous continuation.

## 1.3.13 — 2026-08-12

npm installer publication-verification hardening release.

- Canonicalize the packaged installer bin path and require it in package/release checks.
- Harden scoped OpenCode session bootstrap on Windows.
- Add npm registry visibility retries plus explicit clean-consumer `npm exec` verification of the published installer.

## 1.3.12 — 2026-08-12

Installer-bin packaging hotfix.

- Ship the installer through the committed `bin/opencode-goal.js` shim so the npm bin target exists before publish-time compilation.
- Verify the packed bin link and the published npm `bin.opencode-goal` manifest.

## 1.3.11 — 2026-08-12

Verifier setup/dispatch timeout hardening release.

- Bound semantic-verifier child-session creation and asynchronous dispatch so a hung provider path cannot wedge the parent Goal completion queue.
- Add regression coverage for hung verifier setup and async dispatch.

## 1.3.10 — 2026-08-12

Cadence enforcement and model-context separation release.

- Detect and enforce explicit per-Goal-turn cadence at the host mutation boundary, including one-mutation-unit guidance for cadence-sensitive objectives.
- Scope pending ownership fallback to fast mutation hooks while keeping native Todo planning advisory and non-evidentiary.
- Separate model context-window telemetry from cumulative Goal token budgets and preserve model/progress context across compaction.
- Decouple the semantic-verifier model from the Goal executor model and make verifier/model-context behavior host-aware.

## 1.3.9 — 2026-08-12

Fast-tool ownership hotfix.

- Preserve Goal prompt ownership when a fast model reaches mutation tool hooks before the assistant `message.updated` lifecycle event arrives.
- Keep resulting host mutation progress revision-bound and observable across that race.

## 1.3.8 — 2026-08-12

Semantic verifier retry-loop and across-turn verification hotfix.

- Prefer OpenCode's asynchronous child-prompt transport when available for semantic verification, while retaining the bounded synchronous fallback for older hosts.
- Classify verifier session creation, transport failure, and deadline expiry as verifier-infrastructure outages; persist the Goal as `paused` instead of leaving it active for another automatic idle retry.
- Preserve already collected host command/file audit evidence when an infrastructure outage pauses completion; completion remains fail-closed and queued Goals are never auto-promoted by an outage.
- Added current-revision host runtime evidence for Goal-owned turn count and distinct workspace mutation count so temporal/across-turn requirements cannot be proven from a final file state alone.
- Strengthened continuation/compaction guidance so objectives that explicitly require work across multiple turns/cycles are not intentionally collapsed into one batched edit.
- Hardened `opencode_goal_evidence_file` guidance so semantic/objective requirement IDs are not misused as file-evidence requests.
- Added async-verifier transport, timeout classification, current-revision-turn evidence, and verifier circuit-breaker regressions.
- Validated the feature head with the full required gate set, including real OpenCode native Todo and semantic completion canaries on Ubuntu and Windows.

## 1.3.7 — 2026-08-11

Semantic verifier deadlock / queued-turn hotfix.

- Added a hard 30-second deadline to independent semantic-verifier child sessions so `opencode_goal_complete` cannot wedge the parent Goal turn indefinitely when a provider/model never returns.
- Timed-out verifier child sessions are aborted, and child-session cleanup is separately time-bounded.
- Completion remains fail-closed: a verifier timeout never marks an unproven Goal completed, while the parent turn is released so normal active-Goal continuation can resume.
- Added a never-resolving semantic-verifier regression test and validated it across the Node 20/24 release matrix.
- Preserved successful real OpenCode semantic completion behavior while preventing later commands from remaining permanently `QUEUED` behind a hung verifier.

## 1.3.6 — 2026-08-11

Multi-config installer shadowing hotfix.

- Installer now normalizes every existing supported global OpenCode config filename (`opencode.json`, `opencode.jsonc`, `config.json`, `config.jsonc`) to the same exact Goal package pin.
- Stages every config rewrite before committing any real config change, so an invalid secondary config fails closed without partial mutation.
- Keeps the managed `/goal` command and known local-plugin cleanup behavior while making repeated multi-config installs byte-idempotent.
- Extended cross-platform installer/package smoke coverage for multi-config registration and exact package pinning.

## 1.3.5 — 2026-08-11

OpenCode npm server-entry loader hotfix.

- Added a dedicated `@bybrawe/opencode-goal/server` package export using OpenCode's current plugin-module shape (`{ id, server }`).
- Fixed the remaining case where the managed `/goal` command was discoverable but the server plugin did not load because OpenCode fell back to legacy scanning of the multi-export public root API barrel.
- Preserved the public root JavaScript API while routing OpenCode's npm server loader through a single-purpose server entrypoint.
- Declared the supported OpenCode host range through `engines.opencode` while retaining the production `@opencode-ai/plugin` dependency introduced in 1.3.4.
- Extended unit and packed-package smoke coverage to require `dist/server.js`/`dist/server.d.ts`, assert the server module exports only the plugin object, and prove clean production-only installation still carries the runtime SDK.
- Updated troubleshooting for the visible `OpenCode Goals command bridge` fallback: update to 1.3.5 or newer and fully restart OpenCode.

## 1.3.4 — 2026-08-11

OpenCode npm-plugin loading hotfix.

- Fixed the published plugin failing to load while the managed `/goal` command bridge was still discoverable.
- Moved `@opencode-ai/plugin`, which is imported by the compiled plugin at runtime, into production `dependencies` so OpenCode's isolated npm-plugin cache installs it with the package.
- Hardened package smoke so the tarball must import successfully in a production-only clean consumer without pre-installing the OpenCode SDK as a separate peer fixture.
- The managed command bridge remains a fail-visible diagnostic: if the plugin cannot intercept `/goal`, it tells the user the plugin did not load instead of silently executing the requested Goal as a normal prompt.

## 1.3.3 — 2026-08-11

npm installation/documentation patch release.

- Added an explicit npm-based OpenCode installation path: `npm install -g @bybrawe/opencode-goal@latest` followed by `opencode-goal`.
- Clarified that a project-local `npm install @bybrawe/opencode-goal` alone does not register the plugin with OpenCode.
- Documented update and uninstall flows for both `npx` and global npm installation methods.
- Updated README examples to show the exact `1.3.3` plugin pin and both Loop/Goals global npm installers.

## 1.3.2 — 2026-08-11

Installation, command-discovery, removal, and documentation patch release.

### Install, update, and `/goal` discovery

- Made `npx -y @bybrawe/opencode-goal@latest` the primary README install/update path.
- The installer now creates a managed global `commands/goal.md`, matching OpenCode's supported custom-command discovery path so `/goal` appears reliably in CLI/TUI command lists.
- The managed command is a diagnostic bridge: if the Goal plugin fails to intercept it, the fallback prompt tells the user the plugin did not load instead of silently treating `/goal` arguments as ordinary work.
- Installer refuses to overwrite a user-owned global goal command before mutating config and continues to preserve unrelated OpenCode config/JSONC content.
- Existing package entries remain normalized to one exact `@bybrawe/opencode-goal@<installed-version>` pin to avoid stale package-cache resolution.

### Uninstall

- Added `npx -y @bybrawe/opencode-goal@latest --uninstall`.
- Uninstall removes Goal package/local-plugin registrations plus only the installer-managed `/goal` command file.
- User-owned `goal.md` is preserved.
- Project-local Goal state under `.opencode/goals`, `.opencode/goal-sequences`, and `.opencode/goal-locks` is intentionally preserved unless the user explicitly removes it.

### OpenCode Loop guidance and validation

- Reworked README ordering so install/update/uninstall/troubleshooting are immediately visible.
- Documented that OpenCode Goals and OpenCode Loop can be installed together, while `/goal` and Loop's experimental `/loop-goal`/competing prompt continuations should not drive the same work in one session.
- Extended installer and packed-artifact regression coverage for command creation, command ownership conflicts, uninstall, JSONC preservation, retained project state, and idempotence.

## 1.3.1 — 2026-08-11

Installer/update patch release for npm-based OpenCode setup.

### One-command install and update

- Added the `opencode-goal` package binary so `npx -y @bybrawe/opencode-goal@latest` can install or update OpenCode Goals directly in the user's global OpenCode config.
- The installer creates `~/.config/opencode/opencode.json` when no config exists, or updates the existing OpenCode JSON/JSONC config while preserving unrelated settings and comments outside the managed plugin array.
- Bare, `@latest`, old exact-version, duplicate package entries, and known local `opencode-goal.ts/js` plugin entries are normalized to one exact `@bybrawe/opencode-goal@<installed-version>` pin.
- Re-running the latest installer is idempotent and advances the literal package spec, preventing OpenCode's npm-plugin cache from continuing to resolve an older release.
- Known auto-discovered local Goal plugin copies are removed after the npm package entry becomes authoritative, avoiding double-loading.
- Installer help/version modes are read-only and invalid non-array plugin configuration fails closed instead of rewriting unknown config state.

### Release validation

- Added cross-platform installer regression tests for first install, update/deduplication, JSONC preservation, idempotence, and invalid-config refusal.
- Package smoke now requires the compiled installer in the npm tarball, executes the installed artifact in a clean consumer project, and verifies that it produces the exact OpenCode package pin.

## 1.3.0 — 2026-08-11

Compatible feature release adding revision-bound coordination with OpenCode's native Todo planning while preserving Goal completion as a separate host-verified contract.

### Native Todo orchestration

- Broad and multi-step Goal continuation now steers capable agents to use OpenCode's native `todowrite` plan instead of maintaining a duplicate plugin task database.
- Persisted Todo state is limited to current-revision aggregate telemetry (digest, counts, observation time); Todo text/status never becomes Goal evidence, never increments host progress, and never widens the authorized Goal scope.
- Exact assistant-turn ownership (`goalID + revision`) prevents stale Todo calls from crossing `/goal edit`, pause, restore, or revision boundaries.
- Restore invalidates the archived Todo binding so a resumed Goal must observe current host Todo state again.
- Compaction guidance preserves the Goal/Todo separation and requires the executor to reconcile required work before completion.

### Completion-integrity hardening

- A current observed Todo plan with `pending` or `in_progress` work is now a negative completion veto.
- A fully completed Todo plan remains non-evidence: it cannot prove Goal requirements, host checks, file contracts, or semantic success criteria.
- Missing or stale Todo telemetry cannot block completion because native Todo planning remains optional/advisory.
- The final completion audit rechecks current Todo telemetry, so work reopened while semantic verification is running still prevents a false completion.
- `/goal audit` reports Todo telemetry separately from the proof ledger and labels it advisory rather than completion evidence.

### Validation and benchmark support

- Added deterministic regression/adversarial coverage for Todo telemetry, ownership races, edit/pause/restore invalidation, compaction guidance, audit visibility, and unfinished-plan completion veto behavior.
- Added real-host native Todo canaries on Ubuntu and Windows using an actual OpenCode host while proving Todo activity creates neither Goal progress nor evidence.
- Added a disposable real-model benchmark fixture and hidden external oracle for weak/free-model testing of Todo discipline, repository correctness, verifier-backed completion, and false-completion resistance.
- Existing CI, Actions Security Gate, Release Readiness, Real Host Progress, and Real Restart Recovery gates remain required for the exact release head.

## 1.2.0 — 2026-08-10

Compatible feature release adding ordered multi-Goal workflows and a read-only TUI sidebar while preserving the one-unfinished-live-Goal/session safety model and persisted schema-v1 compatibility.

### Ordered Goal sequences

- Added inert future Goal Contracts with `/goal add`, ordered inspection/reordering/removal/clear controls under `/goal queue`, and explicit `/goal next` promotion.
- Kept exactly one unfinished live Goal per session; queued Goals cannot execute, verify, mutate the worktree, or inherit proof before promotion.
- Verified completion may auto-promote exactly one queue head at the idle boundary only when execution is bound to a known non-Plan agent.
- Promoted Goals start at a fresh revision with fresh evidence, usage, progress, and blocker accounting; proof from the preceding Goal never carries forward.
- Added crash-recoverable activation markers and reused the existing per-session process lease so competing processes cannot consume more than one queue head.
- Added a one-shot activation continuation marker that skips only the pre-turn activation idle; once a real turn exists, normal no-progress accounting resumes.

### TUI sidebar and diagnostics

- Added target-exclusive `@bybrawe/opencode-goal/tui` package export using the official OpenCode `sidebar_content` slot.
- The read-only sidebar shows live status, proven/required count, objective, budget usage, and the ordered queue without participating in mutation or completion policy.
- `/goal doctor` now diagnoses live, archive, and ordered-queue storage, including corrupt JSON/state/session binding and unsafe paths, without rewriting bytes.
- Queue/sidebar presentation fails visible when storage is corrupt or unsafe rather than silently treating unknown state as empty.

### Persistence and cross-platform hardening

- Live Goal snapshots are now explicitly bound to the requested session shard; a mismatched stored `sessionID` fails closed instead of being adopted or listed.
- Hardened Windows process-lease handling for legitimate hard-linked lock files whose `realpath()` may use an equivalent 8.3 path alias, while continuing to reject symlink/junction lock-root escapes before any external write.
- Added adversarial coverage for sequence crash recovery, cross-process single consumption, lock-root path escape, queue diagnostics, TUI read-only safety, and session-shard binding.

### Compatibility and release validation

- Experimental OpenCode 2 explicitly refuses stable-V1 sequence controls; `/goal add` can no longer fall through to V2 live-Goal creation when sequence parity is unavailable.
- Scoped the product unit runner to repository `test/*.test.mjs` so intentionally red benchmark fixtures cannot contaminate release tests.
- Normalized committed benchmark fixture bytes to LF and made timeout assertions process-result based, keeping hidden-oracle contracts reproducible across Windows and Unix.
- The composed mandatory eval corpus now contains 51 adversarial cases across 19 required categories and requires 100% (150/150 weighted).
- Clean package smoke now validates both the stable server entrypoint and the separate TUI package entrypoint.

## 1.1.0 — 2026-08-10

First compatible feature release after 1.0.0. Persisted schema-v1 and the stable V1 OpenCode plugin interface remain compatible.

### Goal control-plane and completion audit

- Added read-only `/goal audit` so the persisted requirement/evidence ledger and completion gate can be inspected without running verification or mutating Goal state.
- Added project-wide read-only Goal discovery with `/goal list` and ID-prefix detail inspection without adopting or mutating foreign-session Goals.
- Hardened autonomous continuation guidance to preserve the full user objective and authorization scope across ordinary shell/edit/test work, compaction, and multiple turns.
- Completion guidance now requires requirement-by-requirement positive proof, scope-matched verification, and treats narrow green tests, stale/indirect evidence, or assistant-authored recommendations as insufficient for broader completion claims.

### Competitive validation tooling

- Added a repo-only competitive benchmark CLI with disposable workspaces, isolated HOME/XDG state, shell-free argv execution, timeout process-tree cleanup, secret redaction, fixture/manifest SHA-256 metadata, and oracle-authoritative scoring.
- Added deterministic hidden-oracle fixtures for normal completion, false-complete resistance, and hard constraint/public-API preservation.
- Added `--preflight` to reject placeholder metadata, unpinned/moving plugin versions, missing provider environment, missing executables, and invalid baseline oracle state before spending model quota.
- Benchmark reports include weighted/category scoring plus detailed redacted JSON/Markdown failure evidence.

### Release and compatibility

- Stable package remains `@bybrawe/opencode-goal` and publishes through npm Trusted Publishing/OIDC.
- Normal OpenCode CLI/TUI/Desktop terminal and tool execution remains work-plane activity: it may change the worktree and produce progress/evidence, but it does not silently rewrite the persisted Goal contract or objective.

## 1.0.0 — 2026-08-09

First stable release.

### Goal contracts and completion integrity

- Persistent Goal Contract with objective, repeatable success criteria, hard constraints/non-goals, host checks, file contracts, budgets, and revision ownership.
- Independent read-only semantic verifier; the executor cannot complete its own Goal by self-report.
- Host-corroborated command/file evidence with stale-evidence rejection and exact revision binding.
- Constraints remain mandatory completion requirements even when narrower mechanical checks pass.

### Autonomous execution safety

- Durable multi-turn continuation with no-progress and blocker guards.
- Plan/restricted-agent execution boundary: planning can define a Goal but cannot silently escape into implementation.
- Foreground/background delegated-task coordination so the parent Goal does not race active child work.
- Provider quota/fatal-error classification plus local turn/token/time/cost budgets.
- User intervention, pause/edit, and verification races fail closed.

### Persistence and recovery

- Project-local atomic Goal storage with process leases and optimistic generation/CAS stale-write refusal.
- Symlink/junction escape protection and fail-closed handling for corrupt or unsupported storage.
- Real process-restart recovery with interrupted-turn accounting preserved.
- Per-session archive/history, explicit live-safe prune, read-only doctor, and safe paused restore.

### OpenCode integration

- `/goal`, `/goal status`, `/goal contract`, `/goal doctor`, lifecycle controls, history, restore, and budget commands.
- Server/session-layer authoritative state usable across normal OpenCode CLI/TUI/web session surfaces.
- Best-effort TUI lifecycle/delegation feedback that never participates in correctness.
- Windows and Ubuntu real-host/restart canaries plus minimum/latest OpenCode plugin compatibility checks.

### Release and supply-chain policy

- npm package: `@bybrawe/opencode-goal`.
- Stable channel publishes to npm `latest` through GitHub Actions trusted publishing/OIDC.
- The publish workflow has `contents: read` and narrowly scoped `id-token: write`; checkout credentials are not persisted.
- Repository workflows do not automatically push commits or merge pull requests.
- Post-1.0 breaking public-interface changes require a new major version.

## 0.1.0-beta.1 / 0.1.0-beta.2

Public prerelease line used to harden verification, persistence, restart recovery, storage integrity/concurrency, Goal Contracts, Plan safety, delegated-task coordination, and release gates before 1.0.0.