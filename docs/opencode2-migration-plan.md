# OpenCode 2 migration: Goal and Loop

Started: 2026-09-29. Work directly on main; do not create repair branches.
Baseline: Goal da4b1c1745e4fa76cf38f982c9582adf880fc7eb and Loop f4a7fedb47bfc03d7630eba6d708704d2d12517a.
Pinned real-host baseline: OpenCode 2.0.18, not a promise about every later host.

## Goal

Migrate behavior to the native V2 API rather than merely renaming imports.
Preserve one continuation owner, Goal identity/revision, budgets, cumulative
usage and host-verified evidence. Keep the explicitly supported V1 adapter
isolated; never initialize it as a side effect of native V2 loading.

## Work plan and exit gates

| Phase | Work | Exit gate | Status |
| --- | --- | --- | --- |
| 0 | Inspect both main branches and official V2 contracts | Baselines and full feature/capability matrix | Baselines recorded; full matrix pending |
| 1 | Plugin lifetime, admission and reload safety | Negative regression followed by passing adapter and complete suites | Goal unload/admission increment verified by creating workflow |
| 2 | Commands, tools, native options, installers and exported types | Native contract for each supported surface | Pending |
| 3 | Completion, usage/retries, compaction and per-unit handoff | Same semantics across native execution and restart boundaries | Existing proof retained; expanded coverage pending |
| 4 | Joint Goal/Loop ownership and diagnostics | No second continuation owner or false completion | Expanded real-host matrix pending |
| 5 | Batch Windows/Linux and clean installed-package checks | Exact final main heads pass before any publication | Pending |

## First Goal increment

- Claim the per-session dispatch slot before resolving persisted state.
  Overlapping triggers cannot both enter admission while a read is pending.
- Keep that slot until native resume settles; always release it on rejected
  eligibility, lookup/admission failure and synchronous host exceptions.
- Failure recovery checks plugin cancellation before and after its persisted
  state read. A removed generation cannot pause a Goal or enqueue recovery
  after a replacement plugin generation has taken responsibility.
- A late admission response cannot repopulate old ownership or start work
  after unload. No native model, tool or compaction abort was introduced.

The creating workflow reproduced the original post-unload recovery failures
through the existing V2 adapter fixture, then ran check, the complete unit
suite, adversarial eval and clean production-tarball smoke tests. New tests
cover late rejection, unload during the recovery read and synchronous resume
rejection. Whole-migration completion and real-provider performance remain
separate gates, not implied by these unit tests.

## Remaining Goal audit

Audit every source of native admission and every async handoff/recovery stage
for cancellation, session/worktree binding and concurrent control changes.
Verify runtime progress, model limits, budgets, independent verification,
queued Goals, per-unit sessions, advisory notifications and TUI support.
Use typed current V2 hooks instead of historical event-shape guesses where
practical. Do not migrate durable Goal storage merely because another API
exists; retain its tested locking, generation and evidence semantics.

## Joint constraints

Goal owns unfinished sessions; Loop must not create a second continuation.
Final units complete through existing checks and independent proof, not unit
identity text. Retired handoff sources remain inert. Preserve existing fixes
for Goal #228 and Loop #164; do not reopen or close unrelated issues to make
the board appear clean. Source/main readiness is not npm publication.

## References

- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/build/plugins/
- https://github.com/ByBrawe/opencode-loop/blob/main/docs/opencode2-migration-plan.md
