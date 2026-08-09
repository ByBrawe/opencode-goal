# OpenCode Goals

**Codex-style persistent Goals for OpenCode, with host-verified completion.**

The design rule is simple: **keep working until the goal is proven done.** The executor cannot complete its own goal merely by saying it is finished.

> `0.1.0-beta.1` is under active development and is not published to npm yet. APIs and commands may change while the verification model is hardened.

## Why this exists

OpenCode is already good at doing a turn of coding work. **OpenCode Goals** adds a durable outcome layer: one explicit goal persists across turns, survives compaction/restarts, continues when the session becomes idle, pauses for user intervention, and refuses completion when required evidence is missing, stale, too narrow, or unverifiable.

This implementation is independently designed for OpenCode. It borrows product principles from durable goal workflows such as **Codex Goals**, but it does not copy their implementation or prompts.

## What makes completion different

Every goal keeps the **full objective itself** as a required semantic item. Extra `--check`, `--file`, `--contains`, and `--accept` contracts add evidence; they never silently replace the broad objective. A narrow green test therefore cannot, by itself, prove a broader goal.

Completion runs as an audit pipeline:

1. The plugin runs declared shell checks itself and records the real exit code and output digest as host evidence.
2. The plugin re-reads declared file contracts itself, confines paths to the project root, and hashes current contents.
3. Semantic requirements are sent to a separate hidden **read-only verifier** session. It has read/glob/grep access but no shell, edit, write, patch, delegation, or goal-mutation tools.
4. A verifier `proven` verdict must cite either an exact `{path, quote}` from the current workspace or a current passing host-evidence ID. The plugin independently re-reads every quoted file and rejects hallucinated paths, quotes, stale evidence, and invented IDs.
5. The goal becomes `completed` only if every required ledger item is proven on the current goal revision and no current verification is failing.

If the verifier does not submit a complete typed verdict, returns ambiguous evidence, or fails for any reason, completion **fails closed** and the goal remains unfinished.

## Beta guarantees

- One unfinished goal per session. Starting another fails closed.
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
- Replaced and explicitly cleared Goals are archived project-locally before the live state is overwritten or removed; archive records are excluded from startup recovery.
- Active Goals recover after a real OpenCode process restart using the persisted session and execution context; the interrupted turn is not falsely counted as stalled.
- Goal state is injected into OpenCode compaction context; OpenCode's generic post-compaction continue is disabled while the goal runtime owns continuation.
- Duplicate idle events cannot launch concurrent continuation prompts.

## Development install

Until the first beta is published, build from the repository and load the package/plugin from your local checkout. The planned npm package name is:

```text
@bybrawe/opencode-goal
```

The product name is **OpenCode Goals**. The plugin command remains `/goal` because it operates on one active goal at a time.

## Usage

```text
/goal fix the failing tests --check "npm test" --contains "README.md::OpenCode Goals"
```

Add semantic acceptance criteria when the requested end state needs more than a mechanical check:

```text
/goal refactor auth --accept "public behavior remains compatible" --check "npm test"
```

Useful lifecycle commands:

```text
/goal status
/goal pause
/goal resume
/goal edit fix tests and update docs
/goal history
/goal history <goal-id-prefix>
/goal clear
```

`/goal history` lists the most recent archived Goals for the current OpenCode session. Use the displayed goal ID prefix to inspect the archived objective, terminal status, requirements, budget, stop reason, and whether it was archived because it was `cleared` or `replaced`. The current live Goal stays in `/goal status`; it enters history when it is cleared or displaced by a later Goal.

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

Host-verifiable file contracts can be declared with `--file path` or `--contains "path::exact text"`. `--accept` criteria and the objective itself are semantic requirements; the independent verifier must prove them from current, host-corroborated evidence.

## Architecture

The project is intentionally split into domain state, verification, runtime/accounting, persistence, and the OpenCode adapter. The domain layer has no dependency on OpenCode, so state invariants can be tested deterministically. Semantic verification is also a separate runtime boundary instead of being embedded in executor prompts.

## Test philosophy

The suite is adversarial by default. It covers false-complete attempts, stale evidence, narrow-check scope bypass, hallucinated verifier quotes, invented host-evidence IDs, parent-session result forgery, user-interrupt races, duplicate idle events, blocker repetition, fake progress, usage deduplication, budget exhaustion/bypass attempts, provider quota classification, fatal/transient provider errors, persistence, archive/history isolation, compaction ownership, process restart recovery, and project-root path traversal.

Real-host canaries exercise lifecycle, semantic verification, active steering, mutation/no-op progress, and persistent SQLite restart recovery on Windows and Ubuntu. CI also checks Bun loading, the minimum declared OpenCode plugin peer, and `@opencode-ai/plugin@latest`.

## Eval corpus

The adversarial regression suite is also exposed as a machine-readable evaluation corpus. The initial required categories are **false-complete, stall, blocker, compaction, restart, provider-limit, budget, and race**.

Run the full corpus:

```text
npm run eval
```

Write a JSON report or focus one category:

```text
npm run eval -- --json eval-report.json
npm run eval -- --category false-complete
```

Each corpus case points at an exact underlying regression test and declares its expected safety outcome. The runner anchors the exact test name and requires exactly one passing target, so renamed or deleted tests cannot silently score as green. It reports per-case results, per-category scores, and a weighted overall score. CI runs the corpus on both Ubuntu and Windows and uploads the JSON reports as workflow artifacts.

The beta gate currently requires every listed case and every required category to pass. The first verified corpus contains nine adversarial cases across all eight categories and scored **100% (24/24 weighted)** on Ubuntu; both platforms remain part of the merge gate for corpus changes.

## Roadmap to stable

1. ✅ Completion integrity and adversarial state-machine tests.
2. ✅ Independent semantic verifier with fail-closed, host-corroborated evidence.
3. ✅ Active objective steering plus hybrid diff/file content progress fingerprints.
4. ✅ Token/time/cost budget UX plus host-backed provider usage-limit states.
5. ✅ Real OpenCode process canaries on Windows/Linux, including persistent restart recovery.
6. ✅ Machine-readable adversarial eval corpus covering false-complete, stall, blocker, compaction, restart, provider-limit, budget, and race scenarios.
7. ✅ Durable per-session archive/history for replaced and cleared Goals.
8. First npm beta after the remaining development and release gates are complete.

## License

MIT
