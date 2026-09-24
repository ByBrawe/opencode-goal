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

This preview still does **not** establish stable OpenCode 2 support. Independent semantic completion/verifier parity and the final combined promotion head remain required before compatibility metadata can be widened.

## Completion and recovery parity

The lifecycle preview does **not** claim stable parity for autonomous Goal completion or recovery.

Before any stable OpenCode 2 lifecycle-support claim, exact-host evidence must separately prove the stable V1 behaviors that are relevant to autonomous execution, including:

- semantic completion transitions and completion evidence;
- no-progress / recovery behavior;
- compaction and restart recovery where those paths affect an active Goal;
- continued Loop coexistence across those transitions.

Until that evidence exists, stable V1 remains the supported lifecycle path and the npm compatibility range remains `<2`.

This separation is intentional: lifecycle command authority and persistence can be promoted experimentally without implying completion/recovery parity that has not yet been demonstrated on OpenCode 2.
