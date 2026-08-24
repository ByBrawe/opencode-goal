# Changelog

All notable changes to **OpenCode Goals** are documented here.

## 1.3.29 — 2026-08-24

Agent-native resume and long-run completion-integrity release.

- Move natural-language paused-Goal resume intent from lifecycle phrase matching into the OpenCode agent/model layer: foreground text stays unchanged in the user's language, paused Goal context tells the model when re-entry is appropriate, and the model may call `opencode_goal_resume` to continue/resume/steer the persisted Goal.
- Keep the routing assistant turn outside Goal ownership: a successful model-selected resume queues re-entry, then the following `session.idle` boundary activates the Goal and lets the existing scheduler dispatch the normal Goal-owned continuation; explicit `/goal resume`, user pause, hard stop states, and other lifecycle guards remain authoritative.
- Make the remaining implicit runtime cap opt-in for newly created Goals (`maxRuntimeMs: 0`), while explicit finite runtime budgets and persisted finite legacy budgets remain hard guards.
- Replace blind 500-record evidence FIFO truncation with audit-aware retention: current-revision trusted proof anchors still referenced by requirements and the latest current host/verifier result for each verification key are retained, preventing long runs from silently losing required proof or forgetting a newer failure.
- Canonicalize host/file and semantic requirement proof pointers to the current proof record instead of accumulating unbounded historical `evidenceIDs`; the normal evidence target stays at 500 records and exceeds it only when the correctness-critical pinned set itself is larger.
- Add multilingual model-resume/ownership regressions and 500+ evidence-record retention regressions; validate unit/eval/package gates, minimum/latest OpenCode plugin compatibility, real lifecycle/steering/compaction/semantic completion, host progress, restart recovery, Loop 0.5.35 coexistence, and Node 20/24 release-smoke matrices across Ubuntu/Windows.

## 1.3.28 — 2026-08-24

Long-running steering and plan reliability release.

- Resume a Goal that was auto-paused by the host no-progress guard when the user sends a concrete foreground work instruction, routing recovery through the normal guarded `/goal resume` chain and preserving the original instruction as active Goal steering; explicit user `/goal pause` remains authoritative.
- Scale the no-progress window from 4 to 12 turns while a current native Todo plan still has open work, so large read/recon/verification-heavy plans do not inherit the same three-turn stall window as short unplanned work.
- Keep prior Todo telemetry visibly stale across `/goal edit` and reject unchanged native Todo digest rebinding to the new Goal revision; a genuinely changed/rebuilt plan may bind current.
- Make cumulative Goal turn caps opt-in for newly created Goals (`maxTurns: 0`), while explicit `--max-turns` / `/goal budget --max-turns` limits and persisted finite legacy budgets remain hard guards.
- Add regressions for auto-stalled steering, explicit pause safety, 100-item Todo plans, Todo revision rebinding, unlimited default turn budgets, and explicit finite caps; validate real lifecycle, steering, compaction, semantic completion, progress, restart recovery, Loop 0.5.35 coexistence, compatibility, eval, and package-smoke gates across Ubuntu/Windows.

## 1.3.27 — 2026-08-23

Cross-plugin command-ownership reliability release.

- Keep foreign/plugin slash-command bridge traffic out of active Goal foreground steering so a companion command cannot repin the Goal executor to its local command agent, model, or variant.
- Correlate command-owned bridge messages with one-time plugin-issued markers, strip valid markers before provider dispatch, and leave spoofed or expired markers as ordinary foreground chat.
- Preserve normal human steering and preemption behavior while maintaining the single-autonomous-owner contract with companion schedulers such as OpenCode Loop.
- Add Ubuntu/Windows real-host coexistence canaries with released OpenCode Loop 0.5.35, including a provider-first-response-byte-delayed case, plus cross-plugin ownership architecture documentation.

## 1.3.26 — 2026-08-22

Transient infrastructure recovery release.

- Persist bounded infrastructure-recovery state for semantic-verifier outages, provider retry, and continuation-dispatch transport failures, with exponential cooldown from 15 seconds up to a five-minute cap.
- Keep OpenCode session ownership authoritative during provider retry/busy/unknown states so Goal never injects a duplicate autonomous prompt over a host-owned turn; add a bounded watchdog for older hosts that can remain in retry indefinitely.
- Recover transient fetch/network/ECONNRESET/ENOTFOUND/EAI_AGAIN/ETIMEDOUT and retryable provider failures without converting a temporary outage into a permanent Goal pause or spending the three-turn no-progress budget.
- Migrate narrowly matching legacy 1.3.25 semantic-verifier timeout pause/block states into automatic recovery while leaving real user pauses, project blockers, authentication failures, and semantic completion proof requirements fail-closed.
- Harden restart and completion races so successful assistant completion cancels pending provider fallback before it can wake late, recovery timers survive persisted state safely, and status output explains infrastructure recovery instead of appearing stuck.

## 1.3.25 — 2026-08-22

Long-running context-budget and compaction-continuation reliability release.

- Make cumulative Goal token caps opt-in for newly created Goals: the default is now unlimited (`maxTokens: 0`), while explicit `--max-tokens` / `/goal budget --max-tokens` limits and persisted legacy budgets remain hard runaway guards. Turn, runtime, cost, no-progress, provider-limit, and completion guards remain unchanged.
- Keep OpenCode's generic post-compaction synthetic continue disabled while an active Goal owns the session, but guarantee exactly one Goal-owned continuation after successful compaction through the normal guarded idle path. Real host idle may claim the same pending continuation, late duplicate idles are suppressed, user steering still wins, and delegated-task/restricted-agent/budget safety gates remain authoritative.
- Separate model input pressure from full context-window pressure in persisted telemetry and detailed `/goal status`: track input-side request tokens independently, report explicit input limits and compaction reserve, and make cases such as a 1M context window with a 272k input ceiling visible without deriving any cumulative Goal budget from those model limits.
- Add regressions for unlimited/default and explicit/legacy token budgets, single-owner post-compaction continuation including delegated-task deferral, and independent context/input-pressure reporting.

## 1.3.24 — 2026-08-21

Final smoke-test edge-case hardening release.

- Let `opencode_goal_evidence_file` resolve the same 1-based requirement number shown by Goal status/get in addition to the exact UUID, while still requiring that the selected requirement is a current file-verification contract.
- Permit narrowly classified read-only shell verification after the one allowed cadence mutation in a distinct-turn Goal; chained commands, pipes, redirection, substitutions, unknown shell forms, and any second workspace mutation remain blocked.
- Keep the dedicated repeated-blocker circuit breaker authoritative by preventing the generic no-progress pause from preempting the third matching blocker report, while changing blocker fingerprints receives no stall exemption.
- Add regressions for numbered file evidence, read-only cadence verification, mutating-shell rejection, repeated-blocker transition to `blocked`, and blocker-key churn.

## 1.3.23 — 2026-08-18

Multilingual core UX and semantic-verifier evidence resilience release.

- Add 25 locale packs for stable core Goal command/sidebar labels, with environment/OS locale detection, English fallback, and unchanged canonical `/goal` subcommand names for script and host compatibility.
- Recognize short explicit resume intent across the supported languages while continuing to route lifecycle control through the existing guarded `/goal resume` chain instead of mutating Goal state directly.
- Harden semantic-verifier file corroboration against model/tool rendering artifacts such as line-numbered read output by conservatively normalizing only literal quote wrappers/prefixes before re-reading the current file.
- When a verifier supplies a malformed root/file citation, recover only through exactly one current passing host file proof whose declared `contains` token matches and whose stored SHA-256 still equals the current file; unrelated hallucinated quotes, stale or ambiguous evidence, and path escapes remain fail-closed.
- Add regressions for line-numbered verifier quotes, malformed root citations backed by fresh host evidence, unrelated hallucinated quote rejection, all 25 locales, multilingual resume intent, and localized command/sidebar ownership behavior.

## 1.3.22 — 2026-08-18

Experimental OpenCode 2 fail-closed safety release.

- Fix exact-beta OpenCode 2 tool registration for the current one-object `tools.add(definition)` contract while retaining the legacy multi-argument prototype path only when the host explicitly exposes it.
- Keep the experimental V2 lifecycle fail-closed/read-only on current hosts: remove model-visible command nonce/capability wrapping, stop registering the mutating `opencode_goals_v2_control` tool, and leave only read-only Goal inspection wired.
- Retain `status` and `contract` through the compatibility control entrypoint, but refuse create/edit/pause/resume/clear/queue/next and other lifecycle mutations with an explicit read-only notice and no Goal storage writes.
- Make experimental context/request presentation read-only, including under Plan, and defensively remove stale control-tool exposure without treating model-visible bridge text as authorization.
- Record exact beta-17498 evidence that plugin tools are not materialized into the effective provider request and real `/goal` origin is lowered to forgeable ordinary user text with empty metadata; OpenCode 2 lifecycle promotion remains blocked on host capabilities tracked in #27, and stable compatibility remains `@opencode-ai/plugin >=1.4.0 <2`.
- Add beta registration, no-mutation lifecycle/sequence, Plan/context, workspace fail-closed, and adversarial eval coverage; validate the hardening head with CI, Actions Security Gate, Real Host Progress, Real Restart Recovery, Release Readiness, and Experimental OpenCode 2 Host.

## 1.3.21 — 2026-08-18

Semantic verifier timeout recovery release.

- When an independent semantic verifier hits a timeout-class infrastructure failure, clean up the timed-out child and retry exactly once in a fresh verifier session before opening the existing fail-closed circuit breaker.
- Bound that automatic retry to at most 60 seconds, or the configured verifier timeout when lower, so a 300-second primary deadline cannot turn into another full five-minute wait and no third automatic attempt is possible.
- Keep non-timeout provider/transport failures single-attempt and fail-closed; if the bounded retry also fails, preserve current audit evidence, pause the Goal, and retain explicit `/goal resume` plus short natural continuation recovery.
- Add cross-platform regressions for synchronous, asynchronous-dispatch, and session-creation timeout bounds, no-third-attempt cleanup, non-timeout no-retry behavior, and successful completion through a fresh retry session.

## 1.3.20 — 2026-08-18

Natural paused-Goal continuation UX release.

- Treat a narrow allowlist of short, explicit continuation messages such as `devam et`, `continue`, `kaldığın yerden devam et`, and `resume` as resume intent when the persisted Goal is paused.
- Route natural-language resume through the existing `/goal resume` command/ownership chain instead of mutating persistence directly, preserving budget, restricted-agent, revision, and lifecycle guards.
- Keep arbitrary foreground chat non-mutating while paused, exclude command-owned/synthetic host messages from natural resume, and retain one-shot actionable paused guidance for ordinary chat.
- Add Turkish/English natural-resume regressions plus ordinary-paused-chat coverage, including `stalledTurns` reset and continuation prompt ownership.

## 1.3.19 — 2026-08-18

Shell completion and Windows Goal storage reliability hotfix.

- Count Goal-owned `bash` activity as host progress only when OpenCode reports a finite numeric process exit; timeout/abort or missing exit metadata remains no-progress, while ordinary nonzero exits still count as completed diagnostic work.
- Retry transient Windows `EPERM`, `EACCES`, and `EBUSY` access/share denials both while reading canonical Goal process-lock owner metadata and while `lstat()`-checking the canonical hard-link, using the same bounded backoff window.
- Preserve fail-closed semantics: `ENOENT`, malformed lock metadata, symlink/junction safety, CAS/lease ownership, POSIX behavior, and persistent Windows access denials retain their prior authority.
- Add regressions proving three distinct timed-out shell turns still reach the normal stall pause, transient Windows owner-read/lstat denials recover to `lock_timeout`, and persistent denials still escape unchanged.

## 1.3.18 — 2026-08-18

Paused-state guidance and progress-guard validation release.

- When ordinary foreground chat reaches a persisted paused Goal, keep the Goal paused and show one actionable warning directing the user to `/goal resume`; never auto-resume or rewrite the user's message.
- Keep read-only Goal command responses and host-generated synthetic task notifications out of paused-chat guidance, reset warning suppression across lifecycle changes, and keep advisory guidance fail-safe for Goal storage integrity diagnostics.
- Extend real-host shell progress coverage on Ubuntu and Windows to prove both sides of the guard: distinct shell-only Goal turns do not false-pause, while repeated identical successful shell commands deduplicate and still reach the normal three-turn stall pause.
- Keep experimental OpenCode 2 activation/readiness evidence isolated from the stable V1 support contract.

## 1.3.17 — 2026-08-18

Shell-heavy Goal progress and diagnostics release.

- Count completed Goal-owned `bash` tool calls as host-observed activity for the no-progress guard without turning shell activity into completion evidence.
- Bind shell activity to the active Goal ID and revision, reject stale completions after Goal edits, deduplicate identical normalized commands by SHA-256, and never persist raw command text in progress notes.
- Add active Goal session-lease diagnostics plus same-project parallel-session isolation coverage.
- Keep experimental OpenCode 2 discovery/activation probes isolated from the stable V1 support contract.

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
- Add npm registry visibility retries for the published installer manifest.

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
