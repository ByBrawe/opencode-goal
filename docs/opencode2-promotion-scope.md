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

## Completion and recovery parity

The lifecycle preview does **not** claim stable parity for autonomous Goal completion or recovery.

Before any stable OpenCode 2 lifecycle-support claim, exact-host evidence must separately prove the stable V1 behaviors that are relevant to autonomous execution, including:

- semantic completion transitions and completion evidence;
- no-progress / recovery behavior;
- compaction and restart recovery where those paths affect an active Goal;
- continued Loop coexistence across those transitions.

Until that evidence exists, stable V1 remains the supported lifecycle path and the npm compatibility range remains `<2`.

This separation is intentional: lifecycle command authority and persistence can be promoted experimentally without implying completion/recovery parity that has not yet been demonstrated on OpenCode 2.
