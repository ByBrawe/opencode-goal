# OpenCode Goals

**Codex-style persistent Goals for OpenCode, with host-verified completion.**

OpenCode Goals keeps working toward an explicit outcome across turns, compaction, delegated work, and process restarts — but completion is controlled by host evidence and an independent verifier, not by the executor saying “done”.

> **Stable release line: `1.1.0`.** Public commands, persisted schema-v1 compatibility, and the verification/safety invariants documented below are stable interfaces. Breaking changes require a new major version.

## Install

```text
npm install @bybrawe/opencode-goal
```

Package:

```text
@bybrawe/opencode-goal
```

The product name is **OpenCode Goals**. The command stays singular (`/goal`) because each OpenCode session has at most one unfinished live Goal.

## Quick start

Create a mechanical Goal:

```text
/goal fix the failing tests --check "npm test" --contains "README.md::OpenCode Goals"
```

Create a Goal Contract with semantic success criteria and hard boundaries:

```text
/goal refactor auth \
  --success "all auth tests pass" \
  --success "existing callers remain compatible" \
  --constraint "do not add a runtime dependency" \
  --non-goal "do not redesign unrelated session code" \
  --check "npm test"
```

Inspect it without changing execution state:

```text
/goal contract
/goal audit
```

Useful lifecycle commands:

```text
/goal status
/goal contract
/goal audit
/goal list
/goal list <goal-id-prefix>
/goal doctor
/goal pause
/goal resume
/goal edit fix tests and update docs
/goal budget
/goal history
/goal history <goal-id-prefix>
/goal history prune --keep 50
/goal restore <goal-id-prefix>
/goal clear
```

## Goal Contract

A Goal is persisted as a contract, not just a prompt string. The contract contains:

- the full outcome/objective;
- repeatable semantic success criteria (`--success` or `--accept`);
- repeatable hard constraints/non-goals (`--constraint`, `--constraints`, `--non-goal`, `--non-goals`);
- host-verifiable command checks;
- host-verifiable file/content contracts;
- local execution budget;
- exact Goal revision and execution context.

The full objective always remains a required semantic requirement. Explicit checks add proof obligations; they never replace the broader outcome.

Every declared constraint is also a required semantic requirement. A green test suite therefore cannot complete a Goal that also says, for example, “keep the public API compatible” unless that boundary is independently proven.

`/goal edit` creates a new revision. Existing success criteria and constraints are preserved when their flags are omitted; evidence from an older revision cannot silently prove the edited Goal.

## Completion integrity

Completion is an audit pipeline:

1. OpenCode Goals runs configured shell checks itself and records real exit status/output digests as host evidence.
2. It re-reads declared file contracts itself, confines paths to the project root, and hashes current content.
3. Semantic requirements are sent to a separate hidden **read-only verifier** session.
4. The verifier has no shell, write/edit/patch, delegation, or Goal-mutation capability.
5. A `proven` verdict must cite current file evidence or a current passing host-evidence ID.
6. The plugin independently re-reads verifier-cited files and rejects hallucinated paths, invented IDs, stale evidence, or quotes that do not exist.
7. The Goal becomes `completed` only when every required ledger item is proven for the current revision and no current verification is failing.

If independent verification is incomplete, ambiguous, unavailable, or races with a user pause/edit, completion **fails closed**.

Continuation also treats verification scope as part of correctness: a narrow green test or search result only proves the requirement it actually covers. Before completion, the executor is instructed to audit the full objective and every required criterion/constraint against current worktree/external state. Missing, stale, indirect, or merely plausible evidence remains unproven.

## Goal audit

`/goal audit` exposes the persisted proof state behind that completion decision without changing it:

```text
/goal audit
```

For an unfinished Goal it reports whether the existing completion gate is `READY` or `NOT READY`, including the same gate reasons used by the domain completion audit. For a completed Goal it reports `COMPLETED` and keeps the persisted completion summary and proof ledger inspectable rather than trying to run the pre-completion gate again.

The audit includes:

- full Goal and owning session IDs;
- status, revision, storage generation, execution binding, budget/usage, progress revisions, stalled turns, and stop/blocker state;
- every requirement with its status, required/optional flag, contract source, verification mode, and evidence references;
- every persisted evidence record with host/verifier/user/agent trust, evidence kind, PASS/FAIL/INFO state, current or stale revision, timestamp, source, and summary.

Audit output intentionally does **not** dump arbitrary evidence metadata or raw command output. More importantly, `/goal audit` is an inspection command, not a verification command: it does not run shell checks, invoke the semantic verifier, refresh evidence, pause/resume the Goal, or rewrite persistence.

## Stable safety guarantees

- One unfinished live Goal per session.
- Project-wide Goal discovery is read-only: inspecting another session cannot adopt, pause, resume, replace, or rewrite its Goal.
- Goal audit is read-only: inspecting proof state cannot refresh evidence, run verification, pause the Goal, or rewrite its snapshot.
- Agent-written progress notes cannot prove completion.
- The executor cannot forge the verifier result from the parent session.
- User intervention wins races with autonomous continuation and verification.
- Duplicate idle events cannot launch concurrent continuation prompts.
- Narration alone does not count as host-observed progress.
- Repeating a blocker inside one turn cannot inflate blocker accounting.
- Local turn/token/time/cost limits stop autonomous work at the exact reached budget.
- An exhausted local budget cannot be bypassed with `/goal resume`; the limit must be raised or cleared first.
- Explicit provider/account quota events become `usage_limited`; ordinary retryable provider failures remain under OpenCode retry policy.
- Fatal provider authentication/non-retryable failures pause fail-closed rather than creating an autonomous error loop.
- Goal/objective/requirement text is task data and cannot override system/developer instructions, repository policy, OpenCode permissions, or selected-agent boundaries.
- OpenCode Goals never requires workflow-driven Git push or automatic PR merge.

## Plan / restricted-agent boundary

`plan` is treated case-insensitively as a planning-only execution boundary.

- Plan may define or edit a Goal Contract.
- The resulting Goal is persisted `paused` before implementation can continue.
- `/goal resume` from Plan cannot activate autonomous implementation.
- Switch to Build and explicitly run `/goal resume` to execute; that re-pins continuation to Build.
- A legacy/raced Plan-bound active Goal is paused on `session.idle` instead of being continued.
- Process restart recovery also refuses to dispatch an implementation prompt for a Plan-bound Goal.

This is enforced by the Goal state machine, not merely by wording in a prompt.

## Delegated task coordination

OpenCode Goals coordinates parent continuation with delegated `task`/subagent work.

- Foreground tasks defer parent idle continuation from the matching tool start until tool completion.
- Background tasks are tracked using the child `sessionId` supplied by OpenCode task metadata.
- Child `session.idle`, `session.error`, `session.deleted`, or a host-marked synthetic terminal task result releases the tracked child.
- If several child sessions are running, every tracked child must become terminal before parent idle auto-continue can resume.
- Waiting does not pause the Goal, increment stalled turns, change revision, or create completion evidence.
- OpenCode Goals does not poll `/session/status` for this decision, avoiding stale `busy` state becoming an unbounded lock.
- Only host-marked `synthetic: true` task-result text receives lifecycle treatment; user-authored lookalike text remains ordinary user intervention.

## Progress and no-progress protection

Host-observed mutating OpenCode tool activity can advance progress accounting. Rewriting identical bytes is deduplicated, and mutations outside the project (including symlink escapes) are ignored.

If autonomous turns keep producing narration without host-observed progress, no-progress protection eventually pauses the Goal instead of burning indefinitely.

A blocker must recur across distinct Goal turns before becoming a durable blocked state.

## Budgets

Create a Goal with local limits:

```text
/goal ship the release --max-turns 60 --max-tokens 600000 --max-minutes 180 --max-cost 25
```

Inspect or change them without changing the Goal revision:

```text
/goal budget
/goal budget --max-turns 80 --max-tokens 800000
/goal budget --max-cost 0
```

`0` means unlimited for that dimension. Raising/clearing a budget keeps existing usage and evidence.

## Persistence, concurrency, and restart recovery

Live Goal state is stored project-locally under:

```text
.opencode/goals/
```

Cross-process lease metadata is separate:

```text
.opencode/goal-locks/
```

Persistence guarantees include:

- atomic live-state writes;
- optimistic `storageGeneration` compare-and-swap protection;
- a live process lease is never stolen;
- competing writers wait and fail closed on timeout instead of writing through another owner;
- a dead lease is reclaimed only after re-validating that the owner process is dead;
- stale process snapshots cannot both commit;
- a stale/concurrent process cannot replace a different unfinished live Goal;
- storage paths below the workspace boundary refuse symbolic-link/Windows-junction escapes;
- corrupt or unsupported live/archive state is never treated as an empty slot;
- path/integrity failures block mutation rather than silently rewriting unknown evidence.

Active Goals can recover after a real OpenCode process restart with persisted execution context. An interrupted turn is not falsely counted as stalled.

## Project-wide Goal index

A project may have live Goal snapshots in several OpenCode sessions. `/goal list` exposes those current snapshots without requiring a persistent TUI widget or changing any session ownership:

```text
/goal list
```

The current session is marked with `*`; each row includes a Goal ID prefix, status, session prefix, update time, and objective. The current session is shown first and the remaining snapshots are ordered by most recent update.

Inspect one live project Goal with its displayed ID prefix:

```text
/goal list <goal-id-prefix>
```

The detail view includes the full Goal ID, full owning session ID, and detailed status. This is intentionally **not** a focus/adopt/switch command. Inspecting a foreign-session Goal never moves it into the observer session and never pauses, resumes, replaces, or rewrites either session's Goal state.

Project indexing uses the same fail-closed storage reader as the live Goal store. A corrupt, unsupported, or unsafe shard therefore blocks a trustworthy project index instead of being silently omitted; use `/goal doctor` from the affected session/storage context to diagnose integrity failures.

## History, restore, and doctor

Replaced and explicitly cleared Goals are archived before their live snapshot is overwritten or removed.

```text
/goal history
/goal history <goal-id-prefix>
```

History is not automatically expired. Retention is explicit:

```text
/goal history prune --keep 50
```

`N` must be a positive integer. Pruning removes only older archive records for the current session and never changes the live Goal.

Restore is intentionally non-autonomous:

```text
/goal restore <goal-id-prefix>
```

An unfinished archived Goal can be restored only when no different unfinished Goal is live. Its evidence, usage, revision, execution context, and contract are preserved, but it returns as `paused`; run `/goal resume` explicitly when you want it to continue. Completed archived Goals cannot be restored.

Storage diagnostics are read-only:

```text
/goal doctor
```

Doctor can report corrupt/unsupported/unsafe storage even when normal Goal loading is impossible. It does not repair, delete, pause, resume, or rewrite state.

## CLI, TUI, web, and headless behavior

Authoritative Goal state lives in the plugin/session layer rather than a visual widget. Lifecycle commands, Goal Contracts, Goal audits, the project-wide Goal index, verification, history, restore, Plan enforcement, and delegated-task coordination therefore do not depend on one particular UI client.

Normal OpenCode work remains a separate work plane. The active agent can use shell/terminal commands, read/edit/write files, delegate tasks, build, and run tests while the same persisted Goal stays intact. Those actions may change the worktree and may create host-observed progress or verification evidence, but they do not silently replace the Goal objective, constraints, revision, or lifecycle state. Goal lifecycle changes come from explicit Goal controls, host-owned completion/blocker/limit transitions, or real user intervention.

When a compatible OpenCode TUI is attached, explicit lifecycle actions and delegated-task waiting may emit best-effort **OpenCode Goals** toasts. Toast delivery is presentation only; a missing/disconnected TUI cannot fail Goal persistence, execution policy, project indexing, audit inspection, or verification.

The stable `1.x` line claims compatibility for the current exported V1 plugin adapter and documented package interface.

## Experimental OpenCode 2 adapter

The repository also contains an **experimental**, opt-in OpenCode 2 adapter at `src/opencode2/experimental.ts`. OpenCode 2's plugin API is still treated as a moving boundary, so this adapter is deliberately isolated from the stable default export and is **not yet a public npm package subpath**.

The adapter follows the current V2 command/tool/session-request model while reusing the same schema-v1 `GoalStore` and domain state:

- V2-style command registration for `/goal $ARGUMENTS`;
- direct Goal read tooling plus a mutating control tool that is removed from ordinary model requests;
- each real `/goal` command request receives an in-process capability marker, and the mutating control accepts only that request's **exact raw arguments exactly once**;
- changed, replayed, or model-initiated control calls fail before Goal storage is read or mutated;
- session `location.directory` is resolved before control/read storage access instead of falling back to the process working directory;
- persistent create/edit/status/contract/pause/resume/clear;
- success criteria, constraints, checks, file contracts, and creation-time budgets;
- Plan create/resume/request enforcement;
- persisted Goal state injection through the V2 `session.hook("request")` boundary.

It intentionally **does not claim parity** for independent semantic completion, autonomous idle continuation, delegated-task coordination, process-restart recovery, budget mutation, history/restore/prune, or doctor. Parity-sensitive controls that are not implemented refuse explicitly without mutating the live Goal.

This separation is a safety feature: the stable V1 adapter remains the supported `1.x` runtime while the V2 adapter must earn each capability through its own adversarial and real-host gates before any stable export/compatibility claim is made.

## Eval corpus

The adversarial regression corpus is machine-readable and mandatory in CI. The stable core corpus is composed with focused stable/experimental fragments so new surfaces can add required cases without weakening existing safety coverage.

Required categories include:

- false-complete
- contract
- audit
- agent-boundary
- delegation
- project-index
- opencode2-experimental
- stall
- blocker
- compaction
- restart
- restore
- storage-integrity
- storage-concurrency
- provider-limit
- budget
- race

Run it:

```text
npm run eval
```

Write JSON evidence or focus one category:

```text
npm run eval -- --json eval-report.json
npm run eval -- --category audit
npm run eval -- --category project-index
npm run eval -- --category delegation
npm run eval -- --category opencode2-experimental
```

The repository gate requires every composed case and every required category to pass. With the read-only audit, project-index, and experimental V2 boundary suites, the composed corpus contains **39 adversarial cases across 17 required categories and requires 100% (114/114 weighted)** on every CI platform. The original `1.0.0` stable release was graduated on the preceding 30-case stable corpus; later compatible releases retain those invariants while adding focused hardening coverage.

## Release quality gates

Before npm publication, `prepublishOnly` runs:

```text
npm run release:check
```

That includes TypeScript checking, the full unit suite, the adversarial eval corpus, and a clean npm tarball consumer install/import smoke test.

GitHub additionally runs:

- CI on Ubuntu and Windows;
- real-host progress canaries on Ubuntu and Windows;
- real process-restart recovery on Ubuntu and Windows;
- release-readiness matrix on Ubuntu/Windows × Node 20/24;
- the Actions Security Gate.

The npm publisher uses GitHub Actions trusted publishing/OIDC. The publish workflow is the only workflow allowed `id-token: write`; it keeps `contents: read`, disables persisted checkout credentials, checks the exact one-shot release version, and publishes the stable release under npm `latest`.

## Architecture

The implementation is intentionally split into:

- domain Goal state and invariants;
- verification/audit and evidence validation;
- read-only Goal proof/audit inspection;
- runtime accounting, blocker, progress, and limits;
- persistence, storage integrity, and process concurrency;
- OpenCode commands and lifecycle adapter;
- project-wide read-only Goal indexing;
- restricted-agent boundaries;
- delegated-task coordination;
- restart recovery and optional UI feedback;
- isolated experimental adapters for evolving OpenCode host APIs.

The domain layer does not depend on OpenCode, so state-machine invariants can be tested deterministically.

## Stability policy

Starting with `1.0.0`:

- documented commands and exported package interfaces follow semantic versioning;
- persisted schema-v1 state remains readable across compatible `1.x` updates;
- completion integrity, fail-closed verification, Plan safety, project-bound storage, and owner-controlled repository release policy are treated as compatibility invariants;
- additions may land in minor versions;
- fixes may land in patch versions;
- breaking public-interface or persisted-contract changes require a new major version;
- experimental source that is not exported by the npm package is outside the stable compatibility claim until explicitly promoted.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

MIT
