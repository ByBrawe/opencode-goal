# OpenCode 2 promotion scope

OpenCode Goals keeps stable OpenCode compatibility at `@opencode-ai/plugin >=1.4.0 <2` while OpenCode 2 support remains evidence-gated.

## Lifecycle preview covered by the promotion gate

On exact OpenCode 2.0.11, the experimental direct lifecycle preview may cover:

- host-native direct `/goal` command origin;
- host user-message identity;
- bounded, single-use lifecycle capability exposure;
- create, status, contract, pause, resume, edit, and clear persistence;
- mismatch, spoof, replay, Plan/read-only, and Location fail-closed behavior;
- continued read-only Goal inspection after mutating capability consumption.

These behaviors do not widen the stable compatibility claim by themselves.

## Autonomous continuation preview

Autonomous V2 continuation remains a second explicit preview. It requires both:

```text
OPENCODE_GOAL_V2_DIRECT_LIFECYCLE=1
OPENCODE_GOAL_V2_AUTONOMOUS=1
```

The autonomous preview never treats a session-wide terminal event as Goal ownership by itself. A Goal continuation is first durably admitted by OpenCode with `resume:false`; only the exact host user-message ID observed again at `session.context` can arm the corresponding execution generation. Direct create/edit/resume executions are kickoff boundaries, not no-progress Goal work turns. Unowned user/read-only executions are ignored for Goal stall accounting.

Successful owned turns reuse the same Goal no-progress boundary as stable V1. Compaction-owned execution terminals remain separate and can schedule at most one post-compaction Goal continuation. Dispatch is fail-closed for read-only/restricted execution state, exhausted budgets, future infrastructure-recovery cooldowns, and stale Goal revisions.

This preview still does **not** establish stable OpenCode 2 support. The final combined promotion head remains required before compatibility metadata can be widened.

## V1 model-context headroom preview

Exact OpenCode 2.0.11 proves that `session.context.model` carries only the selected model identity, while the plugin-level `ctx.model.list()` registry exposes the selected model's authoritative `limit.context`, optional `limit.input`, and `limit.output` values.

The V2 adapter therefore:

- resolves the selected `{ providerID, id }` against `ctx.model.list()` during the identity-bearing `session.context` hook;
- persists the selected execution model as the same `{ providerID, modelID }` shape used by V1;
- feeds registry limits into the shared V1 `observeModelContextLimits()` state instead of guessing from provider configuration;
- preserves the latest request/input usage from exact V2 step telemetry while keeping cumulative Goal token budgets separate from model-window pressure;
- treats registry lookup failure as advisory/fail-closed: no synthetic limits are invented and Goal work is not blocked;
- resets stale model-context telemetry when the selected model identity changes, while repeated identical registry observations remain a semantic no-op.

The production exact-host telemetry parity canary must prove the configured context/output limits are actually persisted in Goal state before stable promotion can rely on model headroom.

## V1 control-plane parity preview

The host-authenticated V2 `/goal` command surface also reuses the stable V1 persistence and formatting layers for Goal administration:

- read-only views: `status`, `contract`, `audit`, `budget` (without a patch), `history`, `doctor`, `list`, and `queue`;
- lifecycle mutations (`create/edit/pause/resume/clear`) retain the one-use host-authorized control capability;
- storage/admin mutations (`budget`, `history prune`, `restore`, `add`, `queue move/remove/clear`, and `next`) run directly inside the host-native `/goal` command callback, so persistence does not depend on a model/provider turn;
- queue state is still stored by `GoalSequenceStore`; only one Goal can be live, queue entries remain inert until promotion, and storage locking/integrity behavior is shared with V1;
- lifting a `budget_limited` Goal or explicitly activating `next` can re-arm autonomous V2 continuation, while restore remains paused until the user explicitly resumes;
- after a Goal-owned V2 execution completes the current Goal, the successful execution boundary may promote the next queued Goal exactly through the same sequence store and schedule the promoted Goal as the new continuation owner;
- ordinary prompt text cannot invoke these mutations: model-visible Goal control remains read-only, while host-native admin commands are admitted only through the real `/goal` command callback after the current session Location is resolved;
- presentation-only follow-up prompts are best effort and never determine whether an admin mutation committed or cause the mutation to be replayed.

Stable promotion requires an exact OpenCode 2.0.11 canary to prove the read-only views remain mutation-free, lifecycle mutation still requires the one-use capability, and representative host-native budget/archive/restore/sequence mutations persist without depending on provider execution.

## V1 telemetry/runtime parity preview

Exact OpenCode 2.0.11 now exposes enough host telemetry to reuse the stable V1 turn-quality policies without counting provider substeps as separate Goal turns:

- all `session.step.ended` samples inside one host execution are folded into one logical Goal-owned turn while preserving token, cost, and execution-runtime accounting;
- the last exact host token sample updates the shared V1 model-context **usage** fields, including cache tokens for request/input pressure calculations;
- non-empty assistant text or any tool activity makes an execution meaningful, so a tool-only turn with an empty final text response is not misclassified as empty;
- a successful execution with no meaningful text/tool activity reuses V1's bounded empty-turn policy: billable usage is preserved, the first empty execution gets one retry/stall exemption, and the second consecutive empty execution pauses the Goal;
- successful `write/edit/apply_patch` tool events reuse V1 file hashing, while `shell/bash` reuses the V1 Git-worktree/read-only-command progress guard;
- progress is accepted only for the current host-owned Goal execution/revision, persisted before notification, and ordinary foreground/direct-lifecycle/compaction activity cannot manufacture Goal progress;
- telemetry and pending shell state are execution/session bounded and terminal/session cleanup is fail-closed.

The exact-host parity canary must prove one real Goal-owned write/tool loop counts as one logical turn and produces durable host progress, followed by two fully empty executions that preserve billable usage and trigger the same bounded pause as V1.

One V1 model-context capability remains intentionally unclaimed here: exact OpenCode 2.0.11 `session.context.model` exposes model identity but not context/input/output limits in the proven hook payload, so context-limit/headroom enforcement is not inferred from undocumented data.

## V1-grade completion preview

When both lifecycle and autonomous V2 previews are enabled, Goal-owned OpenCode 2 executions expose the same model-facing work controls used by stable V1: checkpoint notes, host file evidence, verified completion, waiting-user sleep, and repeated blocker reporting. These controls are visible only to the exact host-admitted Goal-owned execution identity for the current Goal revision; ordinary foreground turns and verifier children do not inherit them.

V2 semantic completion reuses the stable V1 proof core rather than defining a weaker completion rule:

- configured host checks and declared file contracts run before semantic completion;
- semantic requirements are audited in a parent-bound child session;
- verifier context is reduced to read/glob/grep plus the session-bound result tool;
- audit tokens and exact requirement coverage are required;
- current file quotes and host-evidence references are independently corroborated by the host;
- user steering or Goal revision/lifecycle changes invalidate stale completion;
- verifier infrastructure timeout receives the same one bounded retry and then fails closed;
- final persistence still passes through the shared Goal completion audit and durable transition notifier.

Exact-host promotion evidence must prove that a Goal-owned OpenCode 2 turn can invoke this path, produce persisted host + verifier evidence, reach `completed`, and stop further autonomous continuation.

## Completion and recovery parity

The lifecycle/autonomous previews do **not** by themselves claim stable OpenCode 2 support.

Before any stable OpenCode 2 lifecycle-support claim, exact-host evidence must separately prove the stable V1 behaviors that are relevant to autonomous execution, including:

- semantic completion transitions and completion evidence;
- no-progress / recovery behavior;
- compaction and restart recovery where those paths affect an active Goal;
- continued Loop coexistence across those transitions.

Until that evidence exists, stable V1 remains the supported lifecycle path and the npm compatibility range remains `<2`.

This separation is intentional: lifecycle command authority and persistence can be promoted experimentally without implying completion/recovery parity that has not yet been demonstrated on OpenCode 2.
