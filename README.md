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

When a Goal is paused, a short explicit continuation message such as `devam et`, `continue`, or `resume` also resumes it through the same lifecycle control chain. Other normal chat does not silently reactivate a paused Goal.

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

- use `/goal edit <objective>` when you mean to revise the current Goal;
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

## Pause vs. normal chat: explicit continuation and arbitrary chat

`/goal pause` changes persisted Goal state to `paused`. `/goal resume` remains the explicit lifecycle command for reactivating it.

For convenience, a narrow set of short, unambiguous continuation messages — for example `devam et`, `continue`, `kaldığın yerden devam et`, or `resume` — is treated as resume intent while a Goal is paused. The plugin routes that intent through the same `/goal resume` command/ownership chain rather than directly rewriting Goal state.

Other foreground chat stays ordinary conversation and does **not** silently reactivate the Goal. This keeps arbitrary chat from becoming lifecycle control while letting a clear “continue” instruction do what the user expects.

The same resume path can be used after a fail-closed verifier outage. A timeout-class verifier failure first receives one fresh bounded automatic retry; if that retry also fails and the Goal is persisted as `paused`, wait until the verifier/provider is usable and then use `/goal resume` or a short explicit continuation message to retry completion.

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

`/goal edit` creates a new revision. Evidence from an older revision cannot silently prove the edited Goal.

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
- missing or stale Todo telemetry cannot block a newer Goal revision.

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

### Verifier timeout / bounded retry / Goal stays paused

If the executor has finished the work but independent semantic verification hits a timeout-class infrastructure failure, the plugin aborts and cleans up that verifier child and automatically retries **once** in a fresh verifier session. The retry is capped at 60 seconds, or at the configured verifier timeout when that is lower. There is no third automatic verifier attempt.

Non-timeout provider or transport failures are not automatically retried. If the bounded timeout retry also fails, the Goal is persisted as `paused` instead of entering an endless completion retry loop. Existing host evidence remains persisted.

When the verifier/provider is healthy again:

```text
/goal resume
```

A short explicit continuation message such as `continue` or `devam et` uses the same resume path.

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

If the stop reason is verifier infrastructure/timeout after the bounded automatic retry and the workspace is already correct, do not manually repeat the requested mutations. Use `/goal resume` or a short explicit continuation message to retry the completion path.

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