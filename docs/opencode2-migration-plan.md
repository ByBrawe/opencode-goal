# OpenCode 2 migration: Goal and Loop

Started: 2026-09-29. Work directly on main; do not create repair branches.
Initial inventory: Goal da4b1c1745e4fa76cf38f982c9582adf880fc7eb and Loop f4a7fedb47bfc03d7630eba6d708704d2d12517a.
Pinned real-host baseline: OpenCode 2.0.18, not a promise about every later host.

## Goal

Migrate behavior to the native V2 API rather than merely renaming imports.
Preserve one continuation owner, Goal identity/revision, budgets, cumulative
usage and host-verified evidence. Keep the explicitly supported V1 adapter
isolated; never initialize it as a side effect of native V2 loading.

## Work plan and exit gates

| Phase | Work | Exit gate | Status |
| --- | --- | --- | --- |
| 0 | Inspect both main branches and official V2 contracts | Baselines and complete feature/capability matrix | Initial matrix below; per-option audit remains open |
| 1 | Plugin lifetime, admission and reload safety | Negative regression followed by passing adapter and full suites | First Goal increment verified; remaining async paths still need audit |
| 2 | Commands, tools, native options, installers and exported types | Native contract for every supported surface | Native server, sidebar and read-only RPC implemented; per-option audit remains open |
| 3 | Completion, usage/retries, compaction and per-unit handoff | Same semantics across native execution and restart | Handoff unload fences and full-contract three-session coverage added; further race audit remains open |
| 4 | Joint Goal/Loop ownership and diagnostics | No second continuation owner or false completion | Expanded current-head real-host matrix pending |
| 5 | Batch Windows/Linux and clean installed-package checks | Exact final heads pass before any publication | Full migration gate remains open |

## Initial feature matrix

| Surface | Code observed | Remaining migration work |
| --- | --- | --- |
| Server and explicit V2 entry | `src/server.ts`, `src/native.ts`; lazy V1 compatibility | Keep installed-tarball isolation checks; validate exact canonical IDs |
| Goal commands and work tools | `src/opencode2/experimental.ts`, `control-plane.ts`, `work-tools.ts` | Enumerate every command/option and test capability rejection and native hooks |
| Native continuation | Prompt admission/resume with exact host message identity | First lifetime fence implemented; inspect all other deferred callbacks |
| Completion and accounting | Native execution/telemetry/model-limit and semantic verifier modules | Expand stale-revision, Plan, foreground, limit and verifier-failure races |
| Per-unit sessions | `unit-handoff.ts`, `unit-command.ts` and existing three-session canary | Audit cancellation and concurrent controls at each durable handoff phase |
| Installer and package | Existing `plugins` configuration and production tarball checks | Cross-check object options, multiple configs, local/package duplication and uninstall |
| Terminal sidebar | `src/tui/index.ts` exposes native `setup(context)`; `src/tui/native.ts` uses `ui.slot` | Native OpenTUI rendering and reactive session switching tested; V1 entry remains lazy |
| Remote/worktree status | Shared `./rpc` contract and session-bound server projection | Read-only native RPC validates directory/workspace; client has no filesystem fallback |

The initial TUI gap is now implemented through the native CLI slot and RPC
contracts. Rendering is tested with the real OpenTUI test renderer; server RPC
is tested independently on OpenCode 2.0.18 in two locations. These are not a
claim of a live interactive CLI end-to-end test or a cross-machine field test.

## First Goal increment: implemented and tested

- Claim the per-session dispatch slot before resolving persisted state.
  Overlapping triggers cannot both enter admission while a read is pending.
- Keep that slot until native resume settles; release it on rejected
  eligibility, lookup/admission failure and synchronous host exceptions.
- Failure recovery checks plugin cancellation before and after its persisted
  state read. The regressions cover a late rejection after unload and unload
  while that read is suspended. Other persistence/handoff stages remain audit
  targets; these checks are not a blanket proof for every possible unload race.
- A late admission response cannot repopulate old prompt ownership or start
  native resume after unload. No model, tool or compaction abort was introduced.

Verification: [V2 lifetime hardening pass](https://github.com/ByBrawe/opencode-goal/actions/runs/36500333399).
The workflow reproduced the original post-unload recovery failures before
editing source, then passed type checks, the complete unit suite, adversarial
eval and clean production-tarball smoke tests before committing the changes.
The new tests cover late rejection, unload during the recovery read and a
synchronous resume exception. The one-shot write workflow removed itself.

## Next implementation order

1. Keep the native sidebar and read-only RPC covered on Windows/Linux, including
   actual rendering, cleanup, corrupt storage and wrong-location rejection.
   See [native sidebar](opencode2-native-sidebar.md) for the implementation.
2. Complete the command/option matrix and replace historical shape guessing
   with typed current V2 contracts where practical.
3. Expand admission, handoff and retry cancellation tests, then run the two
   actual packaged plugin entries together on the same pinned native host.
4. Run the final Windows/Linux, clean install/uninstall and real-host matrix in
   a batch. Review issues and publication only against those final results.

Do not migrate durable Goal storage merely because another API exists. Retain
its tested locking, generation, recovery and evidence semantics.

## Native sidebar increment

The native sidebar reads the connected server through `opencode-goal-status`
RPC. It passes the displayed session's directory/workspace, never the CLI's
local working directory. The server verifies the session before using its
read-only formatter. Missing RPC, corrupt storage and mismatched responses
remain visible as unavailable. Presentation never changes Goal ownership.

Nine permanent regressions cover isolation, read-only storage, cancellation,
late results, event coalescing and timeouts. The Bun/OpenTUI render smoke checks
visible text, reactive session changes and idempotent cleanup. The real native
RPC canary checks two locations and proves that a client-supplied path cannot
redirect a read, even when the host schema parser strips that extra field.

The package exports `./rpc` and retains a lazy V1 TUI facade. Its V2 dependency
starts at `@opencode/plugin@^2.0.18`; optional OpenTUI peers match the tested
0.5.12 contract, and development UI versions are pinned for reproducibility.
A permanent read-only Windows/Linux workflow retains the new checks.

The current handoff lifetime correction is retained; native RPC and the
full-contract three-session canary are also exercised together. Publication
and the broad current-head matrix remain separately observable gates.

Product commit: `64312391b5c7e9fb01a7dec6be1eecb2b08708aa`.
The [implementation run](https://github.com/ByBrawe/opencode-goal/actions/runs/36503605272)
passed native rendering, two-location RPC, three-session handoff, all 454 unit
cases (452 passed, two platform skips), adversarial evaluation, production
package smoke and the unchanged Actions security gate. The run's overall
conclusion is failure because its runner token could not create the new
workflow during git push. The same tested commit is promoted separately via
the authorized repository connection, without changing the security gate.
This evidence is not a claim that the subsequent main CI has finished.

## Joint constraints

Goal owns unfinished sessions; Loop must not create a second continuation.
Final units complete through existing checks and independent proof, not unit
identity text. Retired handoff sources remain inert. Preserve existing fixes
for Goal #228 and Loop #164; do not close unrelated issues to clear the board.
Source/main readiness is not npm publication, and deterministic canaries are
not measurements of real-provider context cost or long-running reliability.

## References

- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/build/plugins/cli/
- https://opencode.ai/v2/docs/build/plugins/
- https://github.com/ByBrawe/opencode-loop/blob/main/docs/opencode2-migration-plan.md
