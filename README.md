# OpenCode Goals

**Persistent, host-verified Goals for OpenCode.**

OpenCode Goals keeps an explicit outcome alive across turns, compaction, delegated work, and process restarts. Completion is controlled by current host evidence and an independent verifier — not by the executor simply saying “done”.

> **Stable release: `1.3.2`.** The documented `1.x` commands, schema-v1 Goal state, and completion-integrity guarantees remain compatibility boundaries.

## Install or update

Recommended installation for OpenCode CLI, TUI, and desktop/headless sessions:

```bash
npx -y @bybrawe/opencode-goal@latest
```

The installer:

- finds your global OpenCode config directory;
- creates an OpenCode config when none exists;
- adds `@bybrawe/opencode-goal` to the plugin list;
- pins the plugin to the installer’s **exact version** so OpenCode does not keep using a stale npm-plugin cache entry;
- upgrades old/bare/`@latest` Goal package entries;
- removes duplicate old local `opencode-goal.ts/js` copies;
- preserves unrelated OpenCode config and JSONC comments outside the managed plugin array.

Then **fully restart OpenCode** and verify:

```text
/goal status
```

Running the same install command again is the supported update path:

```bash
npx -y @bybrawe/opencode-goal@latest
```

### Uninstall

```bash
npx -y @bybrawe/opencode-goal@latest --uninstall
```

Uninstall removes Goal package registrations and known old local Goal plugin copies from the OpenCode config while preserving unrelated plugins/settings.

Project Goal state is intentionally **not deleted**. Existing state remains under:

```text
.opencode/goals/
.opencode/goal-sequences/
.opencode/goal-locks/
```

Delete those project-local directories yourself only when you intentionally want to erase Goal history/state. Restart OpenCode after uninstalling.

## Quick start

Create a Goal with a real verification check:

```text
/goal fix the failing tests --check "npm test"
```

Create a broader Goal Contract:

```text
/goal refactor auth \
  --success "all auth tests pass" \
  --success "existing callers remain compatible" \
  --constraint "do not add a runtime dependency" \
  --non-goal "do not redesign unrelated session code" \
  --check "npm test"
```

Inspect the active contract and proof state:

```text
/goal status
/goal contract
/goal audit
```

Pause or resume autonomous continuation:

```text
/goal pause
/goal resume
```

## Using OpenCode Goals with OpenCode Loop

`@bybrawe/opencode-goal` and `@bybrawe/opencode-loop` **can both be installed at the same time**. They use different package names, commands, and project state directories.

Recommended split:

- **OpenCode Goals** — use `/goal` when you want a durable outcome contract, revision isolation, host evidence, semantic verification, false-completion protection, restart recovery, and ordered Goals.
- **OpenCode Loop** — use `/loop`, scheduled shell/command jobs, compaction scheduling, and `opencode-loopd` when you want timer/idle-driven repetition or background continuation infrastructure.

Do **not** run OpenCode Goals `/goal` and Loop’s experimental `/loop-goal` against the same work in the same OpenCode session. Both can autonomously continue work on idle boundaries and may compete to start turns.

For the same reason, avoid a prompt-producing `/loop ...` job that continuously injects agent turns into a session while an active OpenCode Goal is autonomously continuing. Use separate sessions, or pause/remove the Loop prompt job while the Goal is active. Timer-driven shell/command jobs should still be used deliberately so they do not race the work being verified.

For the stronger persistent-goal workflow, prefer **OpenCode Goals** over Loop’s experimental Goal Mode.

Install both when needed:

```bash
npx -y @bybrawe/opencode-loop@latest
npx -y @bybrawe/opencode-goal@latest
```

## What OpenCode Goals protects

A Goal is not just a prompt string. It is persisted as a success contract containing the objective, success criteria, constraints/non-goals, host checks, file contracts, execution limits, revision ownership, and evidence ledger.

The system is designed to stop common autonomous-agent failure modes:

- declaring success while work is still incomplete;
- forgetting early requirements after a long context or compaction;
- treating an assistant-written “done” message as proof;
- treating a completed Todo list as proof of the actual Goal;
- reusing stale evidence after `/goal edit`;
- allowing old turns to mutate a new Goal revision;
- losing the Goal after OpenCode/process restart;
- continuing forever without observable progress;
- bypassing configured turn/token/time/cost limits.

## Core commands

| Command | Purpose |
|---|---|
| `/goal <objective>` | Create/replace the current Goal Contract |
| `/goal status` | Show current Goal state |
| `/goal contract` | Show objective, criteria, constraints, checks, files, and limits |
| `/goal audit` | Inspect proof/evidence and the current completion gate |
| `/goal edit <objective>` | Create a new revision of the current Goal |
| `/goal pause` | Pause continuation |
| `/goal resume` | Resume an eligible paused Goal |
| `/goal budget` | Inspect/change local execution limits |
| `/goal list` | Read-only project-wide live Goal index |
| `/goal doctor` | Diagnose live/archive/queue storage without rewriting it |
| `/goal add <objective>` | Queue a future inert Goal Contract |
| `/goal queue` | Inspect/reorder/remove queued Goals |
| `/goal next` | Promote the next Goal when no unfinished live Goal blocks it |
| `/goal history` | Inspect archived Goals |
| `/goal restore <id>` | Restore an unfinished archived Goal as paused |
| `/goal clear` | Clear the current live Goal |

Useful queue controls:

```text
/goal queue
/goal queue move <goal-id-prefix> <position>
/goal queue remove <goal-id-prefix>
/goal queue clear
/goal next
```

## Goal Contracts

Repeatable contract flags let the user define what success means and what must not be violated:

```text
--success "..."
--accept "..."
--constraint "..."
--non-goal "..."
--check "..."
--contains "file::required text"
--max-turns <n>
--max-tokens <n>
--max-minutes <n>
--max-cost <amount>
```

The full objective always remains a required semantic requirement. Narrow checks add proof obligations; they never replace the broader outcome.

`/goal edit` creates a new revision. Evidence from an older revision cannot silently prove the edited Goal.

## Native OpenCode Todo orchestration

For broad/multi-step work, OpenCode Goals can coordinate with OpenCode’s native Todo planning instead of maintaining a duplicate task database.

The boundary is strict:

- Todo text/status never becomes Goal evidence;
- Todo completion never increments Goal progress by itself;
- Todo cannot widen the user-authorized Goal scope;
- a **current** Todo plan with `pending` or `in_progress` work is a negative completion veto;
- a fully completed Todo plan still does **not** prove the Goal;
- missing or stale Todo telemetry cannot block a newer Goal revision.

This lets weak models use a visible execution plan without letting them “launder” incomplete work through completed Todo items.

## Completion integrity

Completion is an audit pipeline rather than an agent self-report:

1. configured shell checks are run by the host and their real exit status/output digest is recorded;
2. declared file contracts are re-read by the plugin inside the project boundary;
3. semantic requirements are sent to a separate read-only verifier session;
4. verifier citations are checked against current files/evidence;
5. stale, invented, indirect, or failing evidence is rejected;
6. current native Todo work is rechecked;
7. every required ledger item must be proven for the current revision before `completed` is persisted.

If verification is unavailable, incomplete, stale, ambiguous, or races with a pause/edit, completion **fails closed**.

## Ordered Goal sequences

A session still has at most **one unfinished live Goal**. Additional Goals are inert queued contracts:

```text
/goal add update docs --success "docs match shipped behavior"
/goal add prepare release notes --check "npm test"
/goal queue
```

Queued Goals cannot execute, verify, mutate the worktree, or inherit evidence until promotion. A promoted Goal starts with fresh revision/progress/evidence state.

## Persistence and restart recovery

Project-local state:

```text
.opencode/goals/
.opencode/goal-sequences/
.opencode/goal-locks/
```

The stable runtime includes atomic writes, optimistic generation/CAS protection, per-session ownership, process leases, path/symlink escape protection, corrupt-state fail-closed handling, and real process-restart recovery.

An interrupted turn is not automatically counted as a stalled turn after recovery.

## Plan/restricted-agent boundary

OpenCode’s Plan context may define/edit a Goal Contract, but it cannot silently cross into autonomous implementation. Plan-created Goals remain paused until execution is explicitly resumed from an eligible execution agent.

This boundary is enforced in the state machine rather than only through prompt wording.

## Delegated work and no-progress protection

OpenCode Goals tracks delegated child work so parent idle continuation does not race running foreground/background tasks.

Narration alone is not treated as host-observed progress. Repeated turns without meaningful host-observed progress eventually pause instead of burning indefinitely.

## CLI, TUI, Desktop, web, and headless use

Authoritative Goal state lives in the plugin/session layer, not in one UI widget. The same Goal contract and completion policy therefore apply across supported OpenCode surfaces.

The package also exposes a separate read-only TUI entrypoint:

```text
@bybrawe/opencode-goal/tui
```

On compatible TUI hosts it can show Goal status, proof count, objective, budget usage, and queued Goals. The sidebar is presentation only; it cannot prove completion or mutate Goal state.

## Testing and release quality

The repository includes:

- deterministic unit/regression tests;
- mandatory adversarial eval cases;
- minimum/current OpenCode plugin compatibility lanes;
- real-host lifecycle, semantic completion, Todo orchestration, steering, and progress canaries;
- real restart/crash recovery on Ubuntu and Windows;
- npm package smoke tests on Ubuntu/Windows with Node 20/24;
- installer/update/uninstall regression tests;
- npm Trusted Publishing/OIDC release flow.

Before a stable npm release, the exact release head is expected to pass the repository’s CI, Actions Security Gate, Release Readiness, Real Host Progress, and Real Restart Recovery workflows.

## Package

```text
@bybrawe/opencode-goal
```

The product name is **OpenCode Goals**; the slash command remains singular because each session has one authoritative unfinished live Goal at a time.

See [CHANGELOG.md](./CHANGELOG.md) for release history and [RELEASING.md](./RELEASING.md) for the release process.

## License

MIT
