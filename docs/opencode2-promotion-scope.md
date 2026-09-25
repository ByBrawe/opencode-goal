# OpenCode 2 stable support scope

OpenCode Goals supports the OpenCode 2 host through the package's dual `./server` entrypoint. The OpenCode 2 lifecycle and autonomous coordinator are enabled by default after the exact-host parity gates described below.

The historical implementation module and CI workflow still use `experimental` / `Experimental OpenCode 2 Host` in some internal names so existing imports and required-check names remain stable. Those names no longer mean that users must opt in to the V2 runtime.

## Default and kill-switch behavior

OpenCode 2 now enables both layers by default:

- host-native `/goal` lifecycle and administration;
- Goal-owned autonomous continuation, semantic verification, accounting, recovery, and compaction coordination.

OpenCode 2-native plugin options are also supported through object-form `plugins` entries. `options.lifecycle` and `options.autonomous` default to `true`; explicit environment overrides take precedence so operators retain an emergency kill switch.

The stable V2 runtime uses the domain APIs introduced by OpenCode 2 rather than emulating V1 hooks: `ctx.session.hook("prompt")` marks user steering at prompt admission, `ctx.session.hook("context")` owns model-request authorization/context, `ctx.session.hook("compaction")` keeps compaction read-only, `ctx.tool.hook("execute.before/after")` drives tool telemetry/progress when present, and long-running Goal work tools use the native executor `context.progress()` surface for UI progress without changing persistence semantics.

The historical environment variables remain as emergency fail-closed kill switches:

```text
OPENCODE_GOAL_V2_DIRECT_LIFECYCLE=0
OPENCODE_GOAL_V2_AUTONOMOUS=0
```

Accepted false values are `0`, `false`, `no`, and `off`. Accepted true values remain `1`, `true`, `yes`, and `on`. An explicitly supplied unrecognized value fails closed instead of enabling mutation accidentally.

Disabling the direct lifecycle layer leaves the persisted-state inspection adapter read-only. Autonomous continuation cannot become active unless the direct lifecycle layer is active.

## Installer/config contract

OpenCode 1 and OpenCode 2 use different package-plugin config dialects.

- OpenCode 1 uses the singular `plugin` array and the managed `commands/goal.md` compatibility bridge.
- OpenCode 2 uses the native plural `plugins` array and the plugin-native `/goal` command. The installer removes only the Goal-owned legacy command bridge when switching to this mode.

When the installer moves a Goal registration between dialects it removes only Goal-owned package/local entries. Unrelated entries in the other dialect are preserved. OpenCode 2 `plugins` entries may be package strings or `{ package, options }` objects.

## Lifecycle authority

OpenCode 2 lifecycle mutation remains fail-closed and host-authorized:

- the host-native direct `/goal` command is the only mutation origin;
- admission records the exact host user-message identity;
- model-visible mutation is exposed only through a bounded, single-use capability tied to that message and execution generation;
- mismatched arguments, replay, spoofed prompt text, Plan/read-only contexts, workspace/Location changes, stale generations, and expired capabilities cannot mutate Goal state;
- admin/storage mutations that do not need a model turn run directly inside the host command callback;
- ordinary request/context/compaction presentation stays read-only unless the exact direct-command capability is armed.

## Autonomous ownership and turn boundaries

A session-wide terminal event is never sufficient to claim Goal ownership. A Goal continuation is durably admitted with `resume:false`; only the exact admitted user-message ID observed again at `session.context` can arm the matching execution generation.

Direct create/edit/resume executions are kickoff boundaries, not Goal work turns. Foreground user work, read-only work, verifier children, and compaction-owned executions do not increment Goal no-progress accounting.

Successful owned turns reuse the stable V1 continuation/no-progress policy. Queue promotion transfers ownership only after the completed Goal is durably persisted and the next Goal is promoted through the shared sequence store.

## Completion and evidence parity

OpenCode 2 uses the shared V1 proof core:

- configured host checks and file contracts execute before semantic completion;
- semantic requirements are independently audited in a parent-bound child session;
- the verifier receives a restricted read-only tool surface plus its session-bound result tool;
- audit tokens, exact requirement coverage, current file evidence, and host evidence are corroborated before completion;
- user steering or Goal revision/lifecycle changes invalidate stale completion attempts;
- verifier infrastructure failure remains bounded and fail-closed;
- completion is persisted through the shared Goal completion audit and transition notifier before autonomous continuation stops.

## Telemetry, accounting, and progress parity

Exact-host telemetry is folded into one logical Goal turn per owned host execution:

- step usage is accumulated without counting provider substeps as separate Goal turns;
- token/cost/runtime accounting uses the shared V1 budget policy;
- write/edit/apply-patch progress uses file hashing;
- shell/bash progress uses the shared Git-worktree/read-only-command guard;
- tool-only turns count as meaningful work;
- empty successful executions reuse V1's bounded empty-turn policy;
- progress must belong to the current Goal ID/revision and is persisted before notification.

Model context limits are resolved from the OpenCode 2 model registry and stored in the shared V1 model-context shape. Missing registry data never causes synthetic limits to be invented.

## Compaction and provider recovery parity

Native OpenCode 2 compaction remains host-owned. Goal observes the compaction boundary, preserves persisted Goal context, and schedules at most one post-compaction continuation. It does not fabricate a second hidden compaction path.

Only a failure belonging to the exact Goal-owned execution can enter Goal recovery policy. Foreground failures are ignored. Prompt overflow, transient infrastructure failure, and fatal/auth failures are normalized into the shared V1 recovery rules. Persistent recovery state is bounded, successful owned execution clears it, and repeated compaction without an intervening successful Goal execution fails closed instead of spinning.

## Todo/materialization boundary

Todo materialization is not a Goal-created OpenCode 2 regression. The stock-vs-Goal differential gate on OpenCode 2.0.16 shows that stock OpenCode exposes no native `todowrite` tool in that host surface and that Goal removes no stock tools. Goal therefore does not synthesize a weaker compatibility-only Todo API.

If OpenCode 2 later exposes a supported native Todo surface, parity can be reconsidered against that host contract without weakening the current Goal evidence model.

## Promotion evidence

The stable V2 path is guarded by exact-host jobs covering:

- package server-entry activation;
- direct command/capability lifecycle;
- runtime execution and compaction boundaries;
- autonomous Goal ownership;
- V1 control-plane behavior;
- telemetry/accounting/progress behavior;
- semantic completion and verifier child-session boundaries;
- host-limit/provider recovery;
- restart recovery and Loop coexistence;
- stock-vs-Goal Todo materialization.

The direct-lifecycle and autonomous canaries intentionally run without V2 opt-in environment variables so the CI gate tests the default production path.

The package still carries its V1 `@opencode-ai/plugin` runtime dependency for the V1 server implementation. This document does not widen that dependency range merely to signal host support; OpenCode 2 host support is provided by the dual server entrypoint and is proven by the OpenCode 2 host gates.
