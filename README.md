# OpenCode Goals

**Persistent, host-verified Goals for OpenCode.**

OpenCode Goals keeps an explicit outcome alive across turns, compaction, delegated work, and process restarts. Completion is controlled by current host evidence and an independent verifier — not by the executor simply saying “done”.

## Install or update

Choose either installation method below. Both end by running the same OpenCode Goals installer, which registers the plugin and installs the `/goal` command.

### Option 1 — one-command install with `npx` (recommended)

```bash
npx -y @bybrawe/opencode-goal@latest
```

Run the same command again whenever you want to update to the latest release.

### Option 2 — install with npm

Install the package globally so the `opencode-goal` installer command is available:

```bash
npm install -g @bybrawe/opencode-goal@latest
opencode-goal
```

To update later:

```bash
npm install -g @bybrawe/opencode-goal@latest
opencode-goal
```

`npm install @bybrawe/opencode-goal` by itself only installs a Node package into the current project. It does **not** register the plugin in OpenCode. For an OpenCode installation, use the global npm method above or the recommended `npx` command.

The installer:

- finds the global OpenCode config directory;
- creates a config if none exists;
- adds/pins `@bybrawe/opencode-goal@<exact-version>` in the OpenCode plugin list;
- upgrades old, bare, or `@latest` Goal plugin entries;
- removes duplicate old local `opencode-goal.ts/js` plugin copies;
- installs a managed global `commands/goal.md` so `/goal` is discoverable by OpenCode;
- preserves unrelated OpenCode settings and JSONC comments outside the managed plugin array.

Then **fully restart OpenCode** and verify:

```text
/goal status
```

You should also see `/goal` when opening OpenCode's slash-command list.

### What gets installed

Default global OpenCode locations:

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

The config contains an exact package pin similar to:

```json
{
  "plugin": ["@bybrawe/opencode-goal@1.3.5"]
}
```

OpenCode loads the npm package through its dedicated `./server` entrypoint. The root package export remains the public JavaScript API and is intentionally separate from the server-plugin module.

### Uninstall

If you installed/updated with `npx`:

```bash
npx -y @bybrawe/opencode-goal@latest --uninstall
```

If you installed the CLI globally with npm:

```bash
opencode-goal --uninstall
npm uninstall -g @bybrawe/opencode-goal
```

Run `opencode-goal --uninstall` **before** removing the global npm package so the installer can remove its OpenCode registrations and managed command file.

Uninstall removes Goal package registrations, known old local Goal plugin copies, and the installer-managed `/goal` command file while preserving unrelated OpenCode config.

Project Goal state is intentionally **not deleted**:

```text
.opencode/goals/
.opencode/goal-sequences/
.opencode/goal-locks/
```

Delete those project-local directories yourself only when you intentionally want to erase Goal history/state. Restart OpenCode after uninstalling.

## `/goal` does not appear or the command bridge reaches the model

If installation succeeded but `/goal` is missing, or the model sees text beginning with `OpenCode Goals command bridge`, the command file loaded but the server plugin did not intercept it. Releases before `1.3.5` could still hit this because OpenCode may fall back to legacy root-module export scanning instead of a dedicated npm server entrypoint.

1. Update/reinstall:

   ```bash
   npx -y @bybrawe/opencode-goal@latest
   ```

   or, for a global npm installation:

   ```bash
   npm install -g @bybrawe/opencode-goal@latest
   opencode-goal
   ```

2. Confirm the installer reports both an exact plugin pin and a managed `/goal` command.
3. Confirm the exact pin is `@bybrawe/opencode-goal@1.3.5` or newer.
4. Confirm `commands/goal.md` exists in the global OpenCode config directory shown above.
5. Fully close every OpenCode CLI/TUI/Desktop process, then reopen it.
6. Do not start OpenCode with `--pure`; pure mode disables external plugins.
7. Run OpenCode's config diagnostics and check for plugin load errors if the command is present but Goal behavior does not activate.

OpenCode officially discovers global custom commands from `~/.config/opencode/commands/`, which is why current releases install `goal.md` there instead of relying only on runtime plugin config mutation.

The installer will **not overwrite a user-owned `commands/goal.md`**. If one already exists, move/rename it or intentionally merge its behavior before reinstalling.

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

Pause or resume:

```text
/goal pause
/goal resume
```

Queue future Goals:

```text
/goal add update docs --success "docs match shipped behavior"
/goal add prepare release notes --check "npm test"
/goal queue
```

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

For broad/multi-step work, OpenCode Goals coordinates with OpenCode's native Todo planning without treating Todo state as Goal proof.

The boundary is strict:

- Todo text/status never becomes Goal evidence;
- Todo completion never increments Goal progress by itself;
- Todo cannot widen the user-authorized Goal scope;
- a **current** Todo plan with `pending` or `in_progress` work vetoes completion;
- a fully completed Todo plan still does **not** prove the Goal;
- missing or stale Todo telemetry cannot block a newer Goal revision.

## Completion integrity

Completion is an audit pipeline:

1. configured shell checks run on the host and their real status/output digest is recorded;
2. declared file contracts are re-read by the plugin inside the project boundary;
3. semantic requirements are sent to a separate read-only verifier session;
4. verifier citations are checked against current files/evidence;
5. stale, invented, indirect, or failing evidence is rejected;
6. current native Todo work is rechecked;
7. every required ledger item must be proven for the current revision before `completed` is persisted.

If verification is unavailable, incomplete, stale, ambiguous, or races with a pause/edit, completion **fails closed**.

## Ordered Goal sequences

A session has at most **one unfinished live Goal**. Additional Goals are inert queued contracts:

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

The runtime includes atomic writes, optimistic generation/CAS protection, per-session ownership, process leases, path/symlink escape protection, corrupt-state fail-closed handling, and process-restart recovery.

## Using OpenCode Goals with OpenCode Loop

Both plugins can be installed together:

```bash
npx -y @bybrawe/opencode-loop@latest
npx -y @bybrawe/opencode-goal@latest
```

Or with global npm installer commands:

```bash
npm install -g @bybrawe/opencode-loop@latest @bybrawe/opencode-goal@latest
opencode-loop
opencode-goal
```

Recommended split:

- **OpenCode Goals**: `/goal` for durable Goal Contracts, host evidence, semantic verification, false-completion protection, revision isolation, restart recovery, and ordered Goals.
- **OpenCode Loop**: `/loop`, scheduled command/shell jobs, compaction scheduling, and `opencode-loopd` for timer/idle-driven repetition and background continuation infrastructure.

Do **not** run `/goal` and Loop's experimental `/loop-goal` against the same work in the same OpenCode session. Both can autonomously continue on idle boundaries and may compete to start turns.

Also avoid leaving a prompt-producing `/loop ...` job continuously injecting turns while an active `/goal` is autonomously continuing. Use separate sessions or pause/remove that prompt loop until the Goal is done.

For new persistent-goal work where completion integrity matters, prefer the dedicated **OpenCode Goals** package over Loop's older experimental Goal Mode.

## Package and release quality

npm package:

```text
@bybrawe/opencode-goal
```

The repository includes deterministic regression tests, adversarial evals, minimum/current OpenCode compatibility lanes, real-host lifecycle/semantic/Todo/steering canaries, restart recovery, cross-platform package smoke tests, dedicated server-entry regression coverage, and installer/update/uninstall tests.

See [CHANGELOG.md](./CHANGELOG.md) for release history and [RELEASING.md](./RELEASING.md) for the release process.

## License

MIT
