# opencode-goal

**Codex-style persistent Goal Mode for OpenCode, with host-verified completion.**

The design rule is simple: **keep working until the goal is proven done.** Agent prose is never enough by itself to prove completion.

> `0.1.0-beta.1` foundation. APIs and commands may change while the verification model is hardened.

## Why this exists

OpenCode is already good at doing a turn of coding work. `opencode-goal` adds a durable outcome layer: one explicit goal persists across turns, survives compaction/restarts, continues when the session becomes idle, pauses for user intervention, and refuses completion when required evidence is missing or stale.

This implementation is independently designed for OpenCode. It borrows product principles from durable goal workflows such as Codex Goals, but it does not copy their implementation or prompts.

## Beta guarantees

- One unfinished goal per session. Starting another fails closed.
- Explicit requirement ledger with `pending`, `proven`, `failed`, `unknown`, and `blocked` states.
- Evidence records carry trust (`host`, `user`, or `agent`) and goal revision.
- Agent-written notes **cannot** prove requirements.
- Editing the objective increments the revision, making old evidence stale for completion.
- Configured `--check` commands are executed by the plugin during completion audit and their real exit codes are recorded as host evidence.
- File evidence is verified by the host, constrained to the project root, and hashed.
- Completion is rejected unless every required item has current trusted evidence and no current host verification is failing.
- Repeating a progress note does not reset no-progress protection.
- A blocker must recur across three distinct goal turns before the state becomes `blocked`.
- Assistant token/cost/time usage is deduplicated by message ID and can stop a goal as `budget_limited`.
- Goal state is stored project-locally under `.opencode/goals/` with atomic writes.
- Goal state is injected into OpenCode compaction context; OpenCode's generic post-compaction continue is disabled while the goal runtime owns continuation.

## Install (beta)

```sh
npm install @bybrawe/opencode-goal
```

Then add the plugin to OpenCode. The plugin registers a `/goal` command when the host supports config mutation.

## Usage

```text
/goal fix the failing tests --check "npm test" --contains "README.md::Goal Mode"
```

Useful lifecycle commands:

```text
/goal status
/goal pause
/goal resume
/goal edit fix tests and update docs
/goal clear
```

Host-verifiable file contracts can be declared with `--file path` or `--contains "path::exact text"`; the agent can then ask the plugin to verify that predeclared contract. Free-form `--accept` criteria are intentionally semantic and cannot be "proven" by attaching an arbitrary file or command. Independent semantic verifier support is planned before stable release.

## Architecture

The project is intentionally split into domain state, verification, runtime/accounting, persistence, and the OpenCode adapter. The domain layer has no dependency on OpenCode, so state invariants can be tested deterministically.

## Roadmap to stable

1. Completion integrity and adversarial state-machine tests.
2. Independent semantic verifier with fail-closed structured claims.
3. Objective steering/edit lifecycle and stronger user-interrupt arbitration.
4. Full token/time/cost budget UX and usage-limit states.
5. Real OpenCode host canaries on Windows/Linux + Bun + minimum/latest plugin compatibility.
6. Eval corpus comparing false-complete, stall, blocker, compaction, restart, and race scenarios.

## License

MIT
