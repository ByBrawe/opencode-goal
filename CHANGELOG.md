# Changelog

All notable changes to **OpenCode Goals** are documented here.

## 1.3.17 — 2026-08-18

Shell-heavy Goal progress and session-lease diagnostics patch release.

- Goal-owned `bash` work now participates in the no-progress guard instead of allowing real shell-heavy work to be misclassified as three stalled continuation turns.
- Shell progress is revision-bound to the active Goal and persisted only as a SHA-256 command fingerprint plus a generic progress note; raw command text is not stored in Goal state.
- Repeating the exact same shell command does not manufacture new progress, and a shell call that finishes after `/goal edit` cannot write progress into the newer Goal revision.
- Completion semantics remain unchanged: shell activity only affects stall/progress accounting and does not become completion evidence by itself.
- Improved same-project session-lock contention messages and added read-only `/goal doctor` diagnostics for active/corrupt Goal session leases.
- Added same-project parallel-session isolation and lease-diagnostic regressions.
- Published `@bybrawe/opencode-goal@1.3.17` and independently verified the public registry manifest, installer bin, full test suite, and packed `dist/opencode/shell-progress.js` artifact.

## 1.3.16 — 2026-08-14

Long-running verification and queued user-steering reliability patch release.

- Increased the default timeout for configured Goal `--check` commands from two minutes to 60 minutes so long Gradle/Xcode/Docker/build checks are not killed prematurely; `OPENCODE_GOAL_CHECK_TIMEOUT_MS` remains available as an override.
- Increased the effective default independent semantic-verifier deadline from 60 seconds to five minutes while preserving explicit plugin/environment overrides and fail-closed completion behavior.
- Ordinary user chat during an active Goal is now treated as steering instead of implicitly pausing the Goal.
- When a Goal model turn is already in flight, only that turn is aborted so the queued user message can run first; the Goal stays active on the same contract revision and autonomous continuation resumes afterward.
- The user-steering assistant turn remains Goal-owned for progress/usage accounting.
- Steering that arrives while checks or semantic verification are running invalidates the stale completion attempt so it cannot complete or pause the Goal behind the user's newer instruction.
- Explicit `/goal pause`, `/goal clear`, `/goal edit`, restricted Plan-agent safety, task-result anti-spoofing, restart recovery, and fail-closed verification remain intact.

## 1.3.15 — 2026-08-12

Lifecycle visibility and verifier transport reliability patch release.

- Added visible Goal lifecycle conflict/warning guidance so create/resume/pause conflicts are surfaced to the user instead of remaining implicit runtime state.
- Added regression coverage for visible lifecycle guidance while preserving command ownership and Goal safety boundaries.
- Preferred the host's bounded synchronous session-prompt path for semantic verification when available, avoiding unreliable async routing on affected OpenCode hosts while retaining bounded failure behavior.
- Added compatibility coverage proving the synchronous prompt path is selected only when supported.
- Improved npm discoverability metadata and README guidance for finding, installing, and operating Goal workflows.

## 1.3.14 — 2026-08-12

Explicit multi-turn process-proof and budget-boundary hardening release.

- Added host-backed process evidence for objectives that explicitly require work across distinct Goal turns, preventing narrative claims such as “10 separate turns” from satisfying a temporal requirement when the work was actually batched.
- Used revision-owned mutation cadence as distinct-turn proof for explicit per-turn objectives instead of treating raw mutation count alone as sufficient.
- Applied the same host process guard to semantic-verifier results so the verifier cannot approve an explicit multi-turn requirement without matching host observations.
- Added real OpenCode 10-turn completion and same-turn batch-rejection canaries.
- Settled reached local Goal budgets at turn/idle boundaries and enforced exhausted budgets before another autonomous continuation can dispatch.
- Hardened native Todo canary session bootstrap without changing Todo's advisory/non-evidence role.

## 1.3.13 — 2026-08-12

Published-installer path and registry-verification hardening release.

- Standardized the npm installer executable on the canonical `bin/opencode-goal.js` path and made package tests require that exact public bin contract.
- Added retry-bounded public-registry verification after Trusted Publishing so transient npm propagation does not produce a false release failure.
- Verified the published installer through explicit `npm exec` from a clean consumer directory.
- Hardened scoped real-host session bootstrap on Windows while keeping release checks fail-closed.

## 1.3.12 — 2026-08-12

Installer packaging hotfix.

- Routed the npm `opencode-goal` executable through a committed bin shim so the declared package executable is valid before TypeScript build output exists.
- Added packed-package verification for the installer bin link and public manifest.
- Added publish-workflow verification that the released npm artifact exposes the expected installer executable.

## 1.3.11 — 2026-08-12

Verifier setup/dispatch deadline hotfix.

- Bounded semantic-verifier child-session setup and asynchronous dispatch so infrastructure that hangs before producing a verifier response cannot wedge the parent Goal indefinitely.
- Preserved fail-closed completion behavior while ensuring verifier infrastructure stalls eventually return control to the Goal runtime.
- Added regressions for hung verifier setup and asynchronous dispatch.

## 1.3.10 — 2026-08-12

Verifier-model isolation and model-context telemetry release.

- Decoupled the semantic verifier from the executor/session-selected model; verifier resolution now follows its own explicit override / OpenCode small-model / default-model / host-fallback path.
- Increased the then-default verifier deadline from 30 to 60 seconds while keeping abort and fail-closed pause behavior. This default was later increased again in 1.3.16.
- Persisted model context-window telemetry separately from cumulative Goal token/cost/runtime budgets.
- Captured host model context/input/output limits and OpenCode auto-compaction state, and exposed model-window state separately in `/goal status` and `/goal audit`.
- Preserved current host-progress revision, mutation count, checkpoint, and model-context telemetry through compaction.
- Reconciled the final observed progress revision during completion/timeout settlement and kept compaction compatible with older schema-v1 snapshots.

## 1.3.9 — 2026-08-12

Fast-provider ownership and explicit per-turn cadence hotfix.

- Fixed a race where a fast provider could reach `write`/`edit`/`apply_patch` hooks before assistant `message.updated` established active ownership, causing a successful edit to be lost from host progress and later trigger the no-progress guard.
- Retained the Goal-generated prompt owner as a short-lived, revision-bound fallback only for mutation hooks; native Todo telemetry remains outside that fallback.
- Bound early tool parts back to pending Goal ownership where possible and rejected old-revision mutation completion after `/goal edit`.
- Detected explicit per-Goal-turn cadence in Turkish and English objectives.
- Enforced at most one successful workspace-mutation unit per explicit cadence turn and blocked further same-turn shell work after that unit so a strong model cannot silently batch a requested multi-turn process into one assistant turn.
- Strengthened continuation/compaction guidance and added ownership, host-progress, cadence-parser, and cadence-boundary regressions.

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
- Installer refuses to overwrite a user-owned `commands/goal.md` and continues to preserve unrelated OpenCode config/JSONC content.
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