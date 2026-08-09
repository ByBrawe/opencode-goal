# OpenCode Goals

**Codex-style persistent Goals for OpenCode, with host-verified completion.**

The design rule is simple: **keep working until the goal is proven done.** The executor cannot complete its own goal merely by saying it is finished.

> `0.1.0-beta.1` is published on npm. The repository is now developing `0.1.0-beta.2`; APIs and commands may still change while the verification, durability, and OpenCode integration model is hardened.

## Why this exists

OpenCode is already good at doing a turn of coding work. **OpenCode Goals** adds a durable outcome layer: one explicit goal persists across turns, survives compaction/restarts, continues when the session becomes idle, pauses for user intervention, and refuses completion when required evidence is missing, stale, too narrow, or unverifiable.

This implementation is independently designed for OpenCode. It borrows product principles from durable goal workflows such as **Codex Goals**, but it does not copy their implementation or prompts.

## Goal Contract

A Goal is more than an objective string. Its persisted **Goal Contract** contains:

- the full outcome/objective;
- optional semantic success criteria (`--success` or `--accept`);
- optional hard constraints/non-goals (`--constraint` or `--non-goal`);
- host-verifiable command and file contracts;
- execution budget and current revision/state.

Every declared constraint is promoted to a **required semantic requirement**. A green test suite therefore cannot complete a Goal if, for example, the Goal also requires the public API to remain compatible and that boundary is still unproven. `/goal contract` renders the current contract read-only without pausing or otherwise mutating an active Goal.

## What makes completion different

Every goal keeps the **full objective itself** as a required semantic item. Extra `--check`, `--file`, `--contains`, `--success`/`--accept`, and constraint contracts add requirements; they never silently replace the broad objective. A narrow green test therefore cannot, by itself, prove a broader goal or trade away a declared boundary.

Completion runs as an audit pipeline:

1. The plugin runs declared shell checks itself and records the real exit code and output digest as host evidence.
2. The plugin re-reads declared file contracts itself, confines paths to the project root, and hashes current contents.
3. Semantic requirements — including the full objective, success criteria, and Goal Contract constraints — are sent to a separate hidden **read-only verifier** session. It has read/glob/grep access but no shell, edit, write, patch, delegation, or goal-mutation tools.
4. A verifier `proven` verdict must cite either an exact `{path, quote}` from the current workspace or a current passing host-evidence ID. The plugin independently re-reads every quoted file and rejects hallucinated paths, quotes, stale evidence, and invented IDs.
5. The goal becomes `completed` only if every required ledger item is proven on the current goal revision and no current verification is failing.

If the verifier does not submit a complete typed verdict, returns ambiguous evidence, or fails for any reason, completion **fails closed** and the goal remains unfinished.

## Beta guarantees

- One unfinished goal per session. Starting another fails closed.
- Persisted Goal Contract with full objective, success criteria, hard constraints/non-goals, host verification contracts, budget, and revision.
- `--success` and `--accept` both create semantic success criteria.
- `--constraint` / `--constraints` / `--non-goal` / `--non-goals` create required semantic boundaries; they cannot be bypassed by narrower passing checks.
- `/goal edit` preserves existing success criteria and constraints when their flags are omitted.
- `/goal contract` is a read-only contract view and cannot pause the current Goal.
- `plan` is a hard execution boundary. A Goal may be defined or edited there, but any resulting active Goal is persisted as `paused` before implementation can proceed.
- `/goal resume` while Plan is selected cannot activate autonomous work. The user must switch to Build and explicitly run `/goal resume`; that turn re-pins future continuation to Build.
- A Plan-bound active Goal cannot escape through `session.idle` or process restart recovery. Both paths pause it without dispatching an implementation prompt.
- Goal/objective/requirement text is treated as user task data and cannot override system/developer instructions, repository policy, OpenCode permissions, or the selected agent/mode.
- A parent Goal does not start a new autonomous idle continuation while a tracked delegated `task` is still running.
- Foreground task deferral follows the real tool-call lifetime. Background task deferral follows OpenCode's child-session lifecycle metadata/events; it does not poll `/session/status`.
- Waiting on delegated work keeps the Goal `active`; it is not counted as a stalled turn and does not consume a fake continuation turn.
- Multiple background children keep the parent deferred until every tracked child is terminal.
- Host-generated synthetic background-task completion/error messages are treated as delegated-task lifecycle input rather than user intervention. Plain user text cannot spoof that path because only `synthetic: true` task results are trusted.
- Explicit requirement ledger with `pending`, `proven`, `failed`, `unknown`, and `blocked` states.
- Evidence records carry trust (`host`, `verifier`, `user`, or `agent`) and the goal revision that produced them.
- Agent-written notes **cannot** prove requirements.
- Editing the objective increments the revision, making old evidence stale for completion.
- The broad objective remains required even when explicit checks or file contracts exist.
- Configured `--check` commands are executed by the plugin during completion audit.
- File evidence is verified by the host, constrained to the project root, and hashed.
- Semantic verification is isolated in a child session and bound to an unguessable audit token plus exact requirement IDs.
- Verifier results cannot be forged from the executor/parent session.
- User intervention wins races with an in-flight completion audit; a paused/edited goal cannot be completed from an old verification snapshot.
- Repeating a progress note does not reset no-progress protection.
- Mutating OpenCode tool activity counts as host-observed progress; narration alone does not.
- A blocker must recur across three distinct goal turns before the state becomes `blocked`.
- Assistant usage is deduplicated by message ID and tracked across turns, tokens, cost, and runtime.
- Local budget exhaustion reports the exact reached limits and stops the goal as `budget_limited`; an exhausted limit cannot be bypassed with `/goal resume`.
- Budget limits can be raised or cleared without changing the goal revision or invalidating evidence; `0` means unlimited.
- Explicit OpenCode account/free-tier quota actions stop the goal as `usage_limited` and abort the retry loop, while ordinary transient provider retries remain under OpenCode's retry policy.
- Fatal provider authentication and non-retryable provider request failures pause the goal fail-closed instead of creating an autonomous error loop.
- Goal state is stored project-locally under `.opencode/goals/` with atomic writes.
- Session-scoped cross-process leases live separately under `.opencode/goal-locks/`, so concurrency metadata cannot be mistaken for live Goal shards.
- A live process lease is never stolen. A competing process waits and then fails closed on timeout rather than writing through another active owner.
- Persisted Goals carry an optimistic `storageGeneration`. If two processes load the same generation, exactly one may commit; the other is rejected as a stale write instead of erasing newer progress.
- A dead lease is reclaimable only after the owner PID is no longer alive and a single cleanup claimant re-validates that exact dead owner. Ambiguous/live ownership is never force-removed.
- A stale/concurrent process cannot replace a different unfinished live Goal ID.
- Storage components below the workspace boundary may not be symbolic links or Windows junctions. Live/history reads, writes, renames, deletes, prune, startup traversal, and process leases fail closed instead of following a redirected storage path outside the project.
- Atomic temp files use exclusive creation and storage paths are re-checked before rename/remove operations.
- Existing Goal storage is never treated as absent merely because its JSON is corrupt, structurally invalid, or uses an unsupported schema version. Reads and mutations fail closed instead of overwriting unknown state.
- Corrupt or unsupported archive records block history restore/prune operations rather than being silently skipped, rewritten, or deleted.
- `/goal doctor` is a read-only storage diagnostic. It reports current-session live/archive health and integrity errors, including `unsafe_path`, without repairing, deleting, rewriting, pausing, resuming, or replacing Goal state.
- Startup recovery isolates corrupt, unsupported, or unsafe live storage instead of letting one damaged shard disable plugin bootstrap; healthy validated active Goals remain eligible for recovery.
- Replaced and explicitly cleared Goals are archived project-locally before the live state is overwritten or removed; archive records are excluded from startup recovery.
- Archive retention is never reduced automatically. `/goal history prune --keep N` is the only built-in retention command; `N` must be a positive integer, only older archive records are removed, and the live Goal is untouched.
- An unfinished archived Goal can be restored only when no unfinished live Goal exists. Restore is atomic, preserves its evidence/usage/revision/execution state, and always returns it as `paused`; the user must explicitly run `/goal resume` before work continues.
- Completed archived Goals cannot be restored.
- Active Goals recover after a real OpenCode process restart using the persisted session and execution context; the interrupted turn is not falsely counted as stalled.
- Goal state — including Goal Contract constraints — is injected into OpenCode compaction context; OpenCode's generic post-compaction continue is disabled while the goal runtime owns continuation.
- Duplicate idle events cannot launch concurrent continuation prompts.
- When a compatible OpenCode TUI is attached, explicit create/edit/pause/resume/clear commands may emit a best-effort **OpenCode Goals** toast. Delegated-task waiting may also emit a one-time informational toast. Toast delivery is optional UI only: missing/disconnected TUI support can never fail Goal persistence or verification.

## Install

The first public beta is available from npm:

```text
npm install @bybrawe/opencode-goal@beta
```

Package name:

```text
@bybrawe/opencode-goal
```

The product name is **OpenCode Goals**. The plugin command remains `/goal` because it operates on one active goal at a time.

The repository can be ahead of the published beta. For unreleased development changes, build and load the plugin from a local checkout instead of assuming `main` and the current npm tarball are identical.

## Usage

A mechanical goal:

```text
/goal fix the failing tests --check "npm test" --contains "README.md::OpenCode Goals"
```

A Goal Contract with explicit success and boundaries:

```text
/goal refactor auth \
  --success "all auth tests pass" \
  --success "existing callers remain compatible" \
  --constraint "do not add a runtime dependency" \
  --non-goal "do not redesign unrelated session code" \
  --check "npm test"
```

Inspect the exact persisted contract at any point:

```text
/goal contract
```

Useful lifecycle commands:

```text
/goal status
/goal contract
/goal doctor
/goal pause
/goal resume
/goal edit fix tests and update docs
/goal history
/goal history <goal-id-prefix>
/goal history prune --keep 50
/goal restore <goal-id-prefix>
/goal clear
```

`/goal contract` renders the full objective, semantic success criteria, constraints/non-goals, host verification contracts, budget, status, and revision. It is read-only and keeps an active Goal active unless the currently selected agent itself is a restricted execution mode such as Plan; in that case the agent boundary pauses execution independently of the read-only command.

`/goal doctor` performs a read-only integrity check for the current session's live snapshot and archive storage. It reports `OK` or `ISSUES FOUND`, identifies `invalid_json`, `invalid_state`, `invalid_archive`, or `unsafe_path` failures with a project-relative path, and never modifies storage. There is intentionally no `--fix` mode; recovery from unknown, corrupt, or redirected storage remains an explicit user decision outside the Goal state machine. Doctor remains available even when the normal live-state parser cannot load an unknown/corrupt snapshot.

`/goal history` lists the most recent archived Goals for the current OpenCode session. Use the displayed goal ID prefix to inspect the archived objective, terminal status, requirements, budget, stop reason, and whether it was archived because it was `cleared` or `replaced`. The current live Goal stays in `/goal status`; it enters history when it is cleared or displaced by a later Goal.

History does not expire automatically. If a project accumulates more archived snapshots than you want to retain, `/goal history prune --keep N` explicitly keeps the newest `N` archives for the current session and removes only older records. `N` must be at least `1`; the command cannot be used as an implicit "delete everything" path and it never changes or pauses the live Goal.

`/goal restore <goal-id-prefix>` recovers an unfinished archived Goal without silently restarting autonomous work. The restored snapshot keeps its goal ID, revision, evidence, usage, progress accounting, budget, Goal Contract, and execution context, but is written back as `paused`. Run `/goal resume` explicitly when you are ready to continue. Restore fails closed if another unfinished Goal is live, if the prefix is ambiguous, or if the archived Goal is already completed.

Goals can be created with local execution budgets:

```text
/goal ship the release --max-turns 60 --max-tokens 600000 --max-minutes 180 --max-cost 25
```

Inspect or change the active goal's budget without changing its objective revision:

```text
/goal budget
/goal budget --max-turns 80 --max-tokens 800000
/goal budget --max-cost 0
```

`0` means **unlimited** for that budget dimension. If a local budget is exhausted, `/goal resume` is rejected until the reached limit is raised or cleared. If OpenCode reports an explicit account/free-tier usage limit, the goal becomes `usage_limited`; after the provider limit resets, `/goal resume` can retry it, and the host will stop it again if the limit is still active.

Host-verifiable file contracts can be declared with `--file path` or `--contains "path::exact text"`. `--success`/`--accept` criteria, constraints, and the objective itself are semantic requirements; the independent verifier must prove them from current, host-corroborated evidence.

## Plan / restricted-agent safety

OpenCode Goals treats `plan` case-insensitively as a planning-only execution boundary. Plan can be used to define or refine the Goal Contract, but the plugin will not let that Goal become an autonomous implementation loophole.

- Creating or editing a Goal from Plan saves the state but persists it as `paused` before implementation continuation.
- `/goal resume` from Plan is re-paused and receives planning-only guidance.
- To execute, switch to Build and explicitly run `/goal resume`; the Goal is then pinned to Build for subsequent autonomous continuation/restart context.
- If an old/raced snapshot is somehow active while still bound to Plan, `session.idle` pauses it instead of dispatching another turn.
- If OpenCode restarts with an active persisted Plan-bound Goal, startup capture pauses it before any recovery prompt. Recovery also re-checks the agent immediately before dispatch.
- Plan safety is state-machine enforcement, not merely wording in the continuation prompt.

## Delegated task coordination

OpenCode's `task` tool can delegate work to child/subagent sessions. OpenCode Goals coordinates its own idle continuation with that lifecycle so the parent Goal does not race a still-running child with a fresh autonomous turn.

- Foreground tasks defer the parent from `tool.execute.before` until the matching `tool.execute.after`.
- Background tasks are tracked by the child `sessionId` OpenCode returns in task metadata and released by child terminal session events or a host-marked synthetic task completion/error message.
- If several background children are active, all tracked children must be terminal before parent idle auto-continue is allowed again.
- Deferral does not change Goal status, revision, evidence, usage, or stalled-turn accounting.
- OpenCode Goals deliberately does **not** poll `/session/status` to decide task completion. Parent coordination is event/lifecycle driven so a stale `busy` status cannot become an unbounded Goal lock.
- A synthetic task result bypasses the ordinary "new user message pauses the Goal" path only when OpenCode marks the text part `synthetic: true`; user-authored lookalike text remains normal user intervention.

For foreground tasks, the current assistant turn naturally receives the child result before the tool call finishes. For background tasks, OpenCode itself injects the completed child result back into the parent session; OpenCode Goals only prevents an unrelated idle-driven parent turn from racing that work.

## OpenCode CLI, TUI, web, and future V2

OpenCode Goals keeps the authoritative state in the server/plugin/session layer rather than in a visual widget. That makes `/goal`, `/goal status`, `/goal contract`, history, restore, agent-boundary state, delegated-task coordination, and verification usable from normal OpenCode session surfaces without making correctness depend on a particular UI client.

The current V1 integration can additionally use the documented TUI toast endpoint for lightweight lifecycle feedback. It intentionally does **not** require an experimental third-party sidebar API, because the package still validates a broad minimum OpenCode plugin peer and headless/server workflows must remain first-class. Lifecycle toasts are finalized after restricted-agent enforcement, so Plan cannot first report a misleading active/resumed state and then be paused.

OpenCode 2 uses a new plugin API and is still beta. A V1 plugin implementation is not treated as V2-compatible merely because command/config files migrate. The roadmap therefore keeps V2 as a separate experimental adapter/compatibility track until its plugin contracts are stable enough for the same real-host and package gates used by the V1 adapter.

## Architecture

The project is intentionally split into domain state, verification, runtime/accounting, persistence, agent/mode boundaries, delegated-task coordination, and the OpenCode adapter. The domain layer has no dependency on OpenCode, so state invariants can be tested deterministically. Semantic verification is also a separate runtime boundary instead of being embedded in executor prompts.

## Test philosophy

The suite is adversarial by default. It covers false-complete attempts, Goal Contract boundary bypass attempts, Plan create/resume/idle/restart escape attempts, delegated foreground/background/multi-child races, synthetic task-result spoof attempts, read-only contract ownership, stale evidence, narrow-check scope bypass, hallucinated verifier quotes, invented host-evidence IDs, parent-session result forgery, user-interrupt races, duplicate idle events, blocker repetition, fake progress, usage deduplication, budget exhaustion/bypass attempts, provider quota classification, fatal/transient provider errors, persistence, unsupported/corrupt storage fail-closed behavior, read-only storage diagnostics, corrupt-shard startup isolation, storage symlink/junction escapes, cross-process live-lock contention, optimistic stale-write races, dead-owner lease recovery, archive/history isolation, explicit live-safe history pruning, safe paused restore, compaction ownership, process restart recovery, optional-TUI failure, and project-root path traversal.

Real-host canaries exercise lifecycle, semantic verification, active steering, mutation/no-op progress, and persistent SQLite restart recovery on Windows and Ubuntu. CI also checks Bun loading, the minimum declared OpenCode plugin peer, and `@opencode-ai/plugin@latest`.

## Eval corpus

The adversarial regression suite is also exposed as a machine-readable evaluation corpus. The required categories are **false-complete, contract, agent-boundary, delegation, stall, blocker, compaction, restart, restore, storage-integrity, storage-concurrency, provider-limit, budget, and race**.

Run the full corpus:

```text
npm run eval
```

Write a JSON report or focus one category:

```text
npm run eval -- --json eval-report.json
npm run eval -- --category delegation
```

Each corpus case points at an exact underlying regression test and declares its expected safety outcome. The runner anchors the exact test name and requires exactly one passing target, so renamed or deleted tests cannot silently score as green. It reports per-case results, per-category scores, and a weighted overall score. CI runs the corpus on both Ubuntu and Windows and uploads the JSON reports as workflow artifacts.

The beta gate requires every listed case and every required category to pass. The current corpus contains thirty adversarial cases across fourteen required categories and requires **100% (87/87 weighted)** on every CI platform.

## Roadmap to stable

1. ✅ Completion integrity and adversarial state-machine tests.
2. ✅ Independent semantic verifier with fail-closed, host-corroborated evidence.
3. ✅ Active objective steering plus hybrid diff/file content progress fingerprints.
4. ✅ Token/time/cost budget UX plus host-backed provider usage-limit states.
5. ✅ Real OpenCode process canaries on Windows/Linux, including persistent restart recovery.
6. ✅ Machine-readable adversarial eval corpus covering false-complete, contract, agent-boundary, delegation, stall, blocker, compaction, restart, restore, storage, provider-limit, budget, and race scenarios.
7. ✅ Durable per-session archive/history for replaced and cleared Goals.
8. ✅ Safe paused restore for unfinished archived Goals.
9. ✅ Explicit live-safe archive retention/pruning without automatic history loss.
10. ✅ Fail-closed storage integrity for corrupt or unsupported live/archive snapshots.
11. ✅ Read-only storage diagnostics plus corrupt-shard startup isolation.
12. ✅ Project-bound Goal storage that refuses symlink/junction escapes.
13. ✅ Cross-process persistence lease plus optimistic generation/CAS stale-write refusal.
14. ✅ First npm beta (`0.1.0-beta.1`) with GitHub Actions trusted publishing/OIDC wiring.
15. ✅ Verified Goal Contracts: success criteria, hard constraints/non-goals, read-only contract view, and portable best-effort TUI feedback.
16. ✅ Plan/restricted-agent safety so an autonomous Goal cannot silently escape a planning-only execution boundary.
17. ✅ Child-task-aware continuation deferral so parent Goals do not race still-running delegated work.
18. Experimental OpenCode V2 adapter after the beta plugin API is sufficiently stable for the same compatibility and real-host gates.
19. Continue hardening toward the next beta and stable release.

## License

MIT