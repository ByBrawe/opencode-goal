# OpenCode Goals

**Language:** **English** · [Türkçe](./README.tr.md)

[![npm version](https://img.shields.io/npm/v/%40bybrawe%2Fopencode-goal)](https://www.npmjs.com/package/@bybrawe/opencode-goal)
[![npm downloads](https://img.shields.io/npm/dm/%40bybrawe%2Fopencode-goal)](https://www.npmjs.com/package/@bybrawe/opencode-goal)
[![license](https://img.shields.io/npm/l/%40bybrawe%2Fopencode-goal)](./LICENSE)

**Persistent, host-verified Goal mode for OpenCode.**

OpenCode Goals is an **OpenCode goal plugin** for long-running AI coding tasks. It adds a durable `/goal` workflow so an OpenCode coding agent can keep one explicit objective across multiple turns, context compaction, interruptions, delegated work, and process restarts — while completion remains gated by current host evidence instead of the executor simply saying “done”.

If you are looking for an **OpenCode autonomous agent**, **persistent goal mode**, **multi-turn coding agent**, **Codex-style long-running goal workflow for OpenCode**, or an OpenCode plugin with **independent completion verification**, this package is built for that use case.

> Independent OpenCode plugin. “Codex-style” describes the long-running goal workflow pattern only; no endorsement or feature-parity claim is implied.

## Install or update

Recommended one-command install:

```bash
npx -y @bybrawe/opencode-goal@latest
```

Run the same command again whenever you want to update.

Or install the installer globally:

```bash
npm install -g @bybrawe/opencode-goal@latest
opencode-goal
```

Then **fully restart OpenCode** and verify:

```text
/goal status
```

You should also see `/goal` in OpenCode's slash-command list.

`npm install @bybrawe/opencode-goal` by itself only installs a Node package into the current project. It does **not** register the plugin in OpenCode. Use the `npx` installer above or the global installer command.

### What the installer does

The installer:

- finds the global OpenCode config directory;
- creates a config if none exists;
- installs/pins `@bybrawe/opencode-goal@<exact-version>` in the OpenCode plugin list;
- upgrades old, bare, or `@latest` Goal plugin entries;
- removes known duplicate legacy local Goal plugin copies;
- installs a managed global `commands/goal.md` so `/goal` is discoverable;
- preserves unrelated OpenCode settings and JSONC comments outside the managed plugin array.

Default OpenCode locations:

macOS / Linux:

```text
~/.config/opencode/opencode.json or opencode.jsonc
~/.config/opencode/commands/goal.md
```

Windows:

```text
%USERPROFILE%\.config\opencode\opencode.json or opencode.jsonc
%USERPROFILE%\.config\opencode\commands\goal.md
```

OpenCode loads the npm package through its dedicated `./server` entrypoint. The root export remains the public JavaScript API.

## Why use OpenCode Goals?

Normal coding-agent conversations can lose the original outcome after many turns, compaction, retries, or interruptions. OpenCode Goals keeps the success boundary explicit and persistent.

Key capabilities:

- **Persistent goals across turns** — the objective remains active across autonomous continuations.
- **Long-running agent workflow** — OpenCode can continue Goal-owned work after idle boundaries.
- **Host-verified completion** — shell checks, file contracts, mutation evidence, and current workspace state can be verified by the plugin.
- **Independent semantic verifier** — the executor does not get to mark itself successful just because it says the work is done.
- **False-completion protection** — missing, stale, indirect, or invented evidence fails closed.
- **Multi-turn cadence protection** — objectives such as “do exactly +1 for 10 separate turns” are not proven by a final file value alone.
- **Restart recovery** — project-local state survives OpenCode/process restarts.
- **Compaction persistence** — Goal context is preserved while OpenCode manages its own model context window. See the [compaction & continuation contract](./docs/COMPACTION-CONTINUATION.md) for active auto/manual compaction ownership and paused-resume semantics.
- **Budgets** — turn, token, runtime, and optional cost limits keep autonomous work bounded.
- **Goal queues** — keep one live Goal while preparing future Goals in an inert ordered queue.
- **Windows / macOS / Linux packaging** — installer and package smoke coverage is cross-platform.

## Quick start

Start a Goal with a real verification command:

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

Inspect the live contract and proof state:

```text
/goal status
/goal contract
/goal audit
```

Pause and resume:

```text
/goal pause
/goal resume
```

When a Goal is paused, a short explicit continuation message such as `devam et`, `continue`, or `resume` resumes the **same revision** through the normal lifecycle control chain. A substantive foreground follow-up is different: when it clearly adds required work, the exact human message can be promoted into a new **extend** revision; when it clearly replaces the requested outcome, it can become a new **replace** revision. Questions, status/explanation requests, and ordinary same-scope steering do not rewrite the Goal contract.

Queue future Goals:

```text
/goal add update docs --success "docs match shipped behavior"
/goal add prepare release notes --check "npm test"
/goal queue
```

## Common use cases

OpenCode Goals is useful when an AI coding agent needs to persist until a real outcome is reached, for example:

- fixing a failing test suite across many iterations;
- carrying a refactor or migration across multiple model turns;
- enforcing “N distinct turns/cycles” or other temporal work requirements;
- preserving an objective through context compaction;
- recovering unfinished work after closing and reopening OpenCode;
- preventing premature “done” claims during autonomous coding;
- requiring file evidence, shell checks, or semantic verification before completion;
- running independent Goals in separate OpenCode sessions while keeping their Goal state isolated.

## Core commands

| Command | Purpose |
|---|---|
| `/goal <objective>` | Start a Goal when no unfinished live Goal blocks creation |
| `/goal status` | Show current Goal state |
| `/goal contract` | Show objective, criteria, constraints, checks, files, and limits |
| `/goal audit` | Inspect proof/evidence and the current completion gate |
| `/goal edit <objective>` | Create a new revision of the current Goal |
| `/goal pause` | Pause autonomous Goal continuation |
| `/goal resume` | Explicitly reactivate an eligible paused Goal |
| `/goal budget` | Inspect/change local execution limits |
| `/goal list` | Read-only project-wide live Goal index |
| `/goal doctor` | Diagnose live/archive/queue storage without rewriting it |
| `/goal add <objective>` | Queue a future inert Goal Contract |
| `/goal queue` | Inspect/reorder/remove queued Goals |
| `/goal next` | Promote the next Goal when no unfinished live Goal blocks it |
| `/goal history` | Inspect archived Goals |
| `/goal restore <id>` | Restore an unfinished archived Goal as paused |
| `/goal clear` | Clear/archive the current live Goal |

## Can I start a second Goal?

A single OpenCode **session has at most one unfinished live Goal**. This avoids two autonomous controllers competing inside the same session.

If a Goal is already active or paused:

- use `/goal edit <objective>` when you want an explicit deterministic rewrite of the current Goal;
- give a substantive foreground follow-up when you want the current Goal to absorb or replace scope naturally; material scope changes become a new revision before implementation continues;
- use `/goal add <objective>` to queue a second Goal for later;
- use `/goal clear` if you intentionally want to abandon/archive the current Goal and start a different one;
- use a **separate OpenCode session** when you intentionally want two Goals to run in parallel.

For queued Goals:

```text
/goal add second objective
/goal queue
/goal next
```

`/goal next` promotes the next queued Goal only when no unfinished live Goal blocks promotion.

Separate sessions have separate persisted Goal snapshots. They can therefore run distinct Goals in the same project directory, although normal workspace conflicts are still possible if both sessions edit the same project files.

## Pause, steering, and user-authorized Goal revisions

`/goal pause` changes persisted Goal state to `paused`. `/goal resume` remains the explicit lifecycle command for reactivating the current revision.

Foreground user messages are classified by intent rather than treating every message as either “resume” or “unrelated chat”:

- **Resume the same Goal:** short, unambiguous messages such as `devam et`, `continue`, `kaldığın yerden devam et`, or `resume` use the existing `/goal resume` ownership chain and keep the same revision.
- **Steer inside the existing scope:** clarifications or implementation guidance that already fit the current objective stay ordinary foreground steering; they do not rewrite the Goal contract.
- **Extend the scope:** a substantive message such as “also do these 100 items” can create a new revision that preserves the previous objective and appends the **exact latest human message** as additional required work.
- **Replace the scope:** a message that intentionally says to abandon/replace the old requested outcome can create a new revision whose objective is the **exact latest human message**.
- **Ask/explain/status:** questions such as “why did it stop?” or “what is left?” do not change Goal status, scope, or revision.

Material scope revisions are host-authorized: the model may choose whether the latest message means extend or replace, but it cannot invent or summarize replacement objective text. Only the exact foreground human message that directly parented that assistant turn can be consumed, once. The revision resets stale native Todo telemetry so the next Goal-owned turn builds a fresh plan, while cumulative usage, budgets, and historical evidence remain preserved. The stale pre-revision assistant turn is not allowed to keep mutating the workspace after the revision boundary.

`budget_limited`, `usage_limited`, and completed states are not implicitly bypassed by foreground chat. Use the explicit Goal budget/lifecycle controls when those states require intervention. `/goal edit` remains available whenever you want deterministic manual control over the exact resulting objective.

Transient verifier/provider/network failures are different from a user pause. Since 1.3.26, retryable infrastructure failures use persisted recovery/backoff rather than normally requiring a manual `/goal resume`: Goal respects host `retry`/`busy`/unknown ownership, backs off from 15 seconds up to a five-minute cap, survives process restarts, and avoids spending the normal no-progress budget on infrastructure failure. A short resume command remains useful for an actual user pause or compatible legacy state, but it is not the normal recovery mechanism for a current retryable outage.

## Goal Contracts

Repeatable contract flags define success and hard boundaries:

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

New Goals have no cumulative token cap by default (`maxTokens: 0`). Use `--max-tokens` or `/goal budget --max-tokens` only when you want an explicit total-work runaway guard; this cumulative budget is separate from the selected model's current context/input window.

The full objective always remains a required semantic requirement. Narrow checks add proof obligations; they never replace the broader outcome.

`/goal edit` and material foreground scope changes create a new revision. Evidence from an older revision cannot silently prove the edited/rebased Goal.

## Multi-turn cadence and anti-batching

OpenCode Goals is designed for objectives that explicitly require work across multiple distinct turns or cycles.

Example:

```text
/goal 10 ayrı goal turunda counter.json içindeki value değerini her tur tam +1 artır. Başlangıç 0, final 10. Tek seferde +10 yapma.
```

For this kind of objective, the plugin tracks host-observed workspace mutation fingerprints and Goal progress across the current revision. A model should perform the requested per-turn unit and end its turn instead of collapsing the work into one batch.

A final `{"value":10}` alone does not prove that ten distinct +1 turns occurred.

## Native OpenCode Todo orchestration

For broad multi-step work, OpenCode Goals coordinates with OpenCode's native Todo planning without treating Todo state as Goal proof.

The boundary is strict:

- Todo text/status never becomes Goal evidence;
- Todo completion never increments Goal progress by itself;
- Todo cannot widen the user-authorized Goal scope;
- a current Todo plan with `pending` or `in_progress` work vetoes completion;
- a fully completed Todo plan still does **not** prove the Goal;
- missing or stale Todo telemetry cannot block a newer Goal revision;
- a material user-authorized Goal revision discards the stale Todo snapshot so the next Goal-owned turn must re-plan the new revision.

## Completion integrity

Completion is an audit pipeline:

1. configured shell checks run on the host and their actual result/output digest is recorded;
2. declared file contracts are re-read by the plugin inside the project boundary;
3. semantic requirements are sent to a separate read-only verifier session;
4. verifier citations are checked against current files/evidence;
5. host-observed current-revision turn/progress facts are available for temporal requirements;
6. stale, invented, indirect, or failing evidence is rejected;
7. current native Todo work is rechecked;
8. every required ledger item must be proven before `completed` is persisted.

If verification is unavailable, incomplete, stale, ambiguous, or races with a lifecycle change, completion **fails closed**.

### Verifier/provider infrastructure recovery

A timeout-class semantic-verifier failure still gets one fresh bounded verifier retry after the failed verifier child is aborted and cleaned up. If verification or the provider remains unavailable for a retryable infrastructure reason, current releases do **not** normally convert that temporary outage into a permanent manual pause. The Goal records persisted infrastructure-recovery state and retries with exponential cooldown starting at 15 seconds and capped at five minutes.

The recovery coordinator also covers retryable provider/transport failures such as transient fetch/network errors, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, and `ETIMEDOUT`. While OpenCode reports `retry`, `busy`, or an unknown/non-idle ownership state, Goal does not inject a competing autonomous prompt. A bounded watchdog exists for older hosts that can remain stuck in retry, and the recovery state survives a process restart.

Infrastructure recovery does not prove completion and does not spend the normal no-progress/stall budget. Fatal authentication/configuration failures and explicit host usage limits remain fail-closed and require the appropriate user/configuration action.

A verifier outage never marks an unproven Goal completed.

## Persistence and restart recovery

Project-local state:

```text
.opencode/goals/
.opencode/goal-sequences/
.opencode/goal-locks/
```

The runtime includes atomic writes, optimistic generation/CAS protection, per-session ownership, process leases, path/symlink escape protection, corrupt-state fail-closed handling, and process-restart recovery.

Goal cumulative token/runtime budgets are intentionally separate from the selected model's current context window. `/goal status` reports the host-observed full context pressure and, when the model exposes a smaller input limit, input-side pressure separately. OpenCode remains responsible for deciding when to compact.

While an active Goal owns a session, the plugin keeps OpenCode's generic post-compaction synthetic continue disabled and resumes through exactly one Goal-owned guarded continuation path instead, so compaction does not require a manual `continue` and does not create two competing continuation owners.

## Troubleshooting

### `/goal` is missing or the command bridge reaches the model

Reinstall/update:

```bash
npx -y @bybrawe/opencode-goal@latest
```

Then:

1. confirm the installer reports an exact package pin and a managed `/goal` command;
2. confirm `commands/goal.md` exists in the global OpenCode config directory;
3. fully close every OpenCode CLI/TUI/Desktop process and reopen it;
4. do not start OpenCode with `--pure`, which disables external plugins;
5. inspect OpenCode config diagnostics for plugin-load errors.

The installer does **not** overwrite a user-owned `commands/goal.md`.

### Goal is paused after completion work finished

Check:

```text
/goal status
/goal audit
```

If `/goal status` reports current infrastructure recovery, let the persisted recovery/backoff path retry; do not manually repeat already-correct workspace mutations. If the Goal is genuinely user-paused, restored from a compatible legacy state, or otherwise eligible for manual reactivation, use `/goal resume` or a short explicit continuation message. Fatal authentication/configuration errors and explicit usage/budget limits must be fixed explicitly rather than bypassed by resume/revision chat.

### I gave the paused Goal a large new list but it did not belong to the old plan

You can send the new requirements as ordinary foreground text. When they materially add work, Goal creates an extend revision from the exact message and rebuilds native Todo planning on the next Goal-owned turn. If you explicitly replace the old outcome, it creates a replace revision instead. Use `/goal edit <objective>` when you want to force an exact manual rewrite.

### I cannot start another Goal in the same session

That session already has an unfinished live Goal. Choose one:

```text
/goal edit <replacement objective>
/goal add <future objective>
/goal clear
```

Or open a second OpenCode session for parallel work.

## Using OpenCode Goals with OpenCode Loop

Both plugins can be installed together:

```bash
npx -y @bybrawe/opencode-loop@latest
npx -y @bybrawe/opencode-goal@latest
```

Recommended split:

- **OpenCode Goals** — persistent `/goal` contracts, host evidence, completion verification, false-completion protection, revision isolation, restart recovery, and ordered Goals.
- **OpenCode Loop** — `/loop`, scheduled command/shell jobs, compaction scheduling, and timer/idle-driven repetition infrastructure.

Do **not** run `/goal` and Loop's experimental `/loop-goal` against the same work in the same OpenCode session. Both can autonomously continue and may compete to start turns.

Also avoid leaving a prompt-producing `/loop ...` job continuously injecting turns while an active `/goal` is autonomously continuing. Use separate sessions or pause/remove that prompt loop until the Goal is done.

## Package and release quality

npm package:

```text
@bybrawe/opencode-goal
```

The repository includes deterministic regression tests, adversarial evals, minimum/current OpenCode compatibility lanes, real-host lifecycle/semantic/Todo/steering canaries, restart recovery tests, cross-platform package smoke tests, dedicated server-entry regression coverage, and installer/update/uninstall tests.

See [CHANGELOG.md](./CHANGELOG.md) for release history and [RELEASING.md](./RELEASING.md) for the release process.

## Uninstall

If installed/updated with `npx`:

```bash
npx -y @bybrawe/opencode-goal@latest --uninstall
```

If the installer CLI is global:

```bash
opencode-goal --uninstall
npm uninstall -g @bybrawe/opencode-goal
```

Project Goal state is intentionally **not deleted** during uninstall:

```text
.opencode/goals/
.opencode/goal-sequences/
.opencode/goal-locks/
```

Delete those directories yourself only when you intentionally want to erase project-local Goal state/history.

## License

MIT