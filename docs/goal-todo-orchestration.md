# Goal to native OpenCode Todo orchestration

OpenCode Goals treats a Goal and OpenCode's native Todo list as two different layers:

- **Goal**: the persistent user-authorized outcome, constraints, requirements, budgets, and completion proof boundary.
- **Native Todo list**: the current execution plan the active OpenCode agent uses to organize concrete work toward that Goal.

The Todo list is never copied into the Goal requirement ledger and never becomes completion evidence.

## Intended broad-Goal flow

A user should be able to start with a short objective such as:

```text
/goal analyze this project, identify incomplete required work, and finish it
```

For a broad/discovery-shaped Goal, the active agent should:

1. inspect enough current repository/external state to understand the existing product scope;
2. derive concrete work that is actually required by the Goal, repository policy, current tests/docs, or declared constraints;
3. use OpenCode's native `todowrite` tool when it is available and permitted for a multi-step plan;
4. keep at most one Todo item `in_progress`, updating items when work actually starts or finishes;
5. add newly discovered work only when current evidence shows it is required by the already-authorized Goal scope;
6. use normal read/edit/write/shell/test/task tools to perform the work while the Goal remains unchanged;
7. reconcile the Todo plan before completion, but treat Todo status only as planning state;
8. call Goal completion only after the full objective and every required criterion/constraint are proven by the existing host/verifier audit pipeline.

Assistant-generated nice-to-haves, unrelated cleanup, speculative improvements, or follow-up suggestions do not become authorized work merely because they can be added to a Todo list.

## Persistence and ownership model

OpenCode owns and persists the native Todo list for the session. OpenCode Goals persists only aggregate advisory telemetry:

- the Goal revision that observed the plan;
- a deterministic plan digest;
- pending / in-progress / completed / cancelled counts;
- observation time.

Todo item text is not duplicated into Goal persistence.

A native `todowrite` result is attached to Goal telemetry only when the tool call belongs to the exact current assistant Goal turn (`goalID + revision`). A tool call from an older revision, or one that finishes after the Goal is paused, is ignored.

Editing a Goal keeps the prior aggregate telemetry visible as **STALE** so continuation can rebuild the plan for the new revision. Restoring an archived Goal clears the old Todo binding because the session Todo database may have changed while the Goal was archived.

Todo telemetry:

- does **not** increment `progressRevision`;
- does **not** create evidence records;
- does **not** prove requirements;
- does **not** authorize scope changes;
- does **not** block Goal execution if `todowrite` is unavailable or denied.

## Manual real-host test

Use a disposable repository with several discoverable required gaps and a deterministic acceptance script. Then run:

```text
/goal analyze this project and finish the required incomplete work without adding unrelated features
```

Expected observations:

1. The agent performs reconnaissance before inventing a large checklist.
2. For 3+ concrete steps, the OpenCode UI/TUI shows a native Todo list.
3. Only required current-scope work appears in that list; unrelated improvements are omitted/cancelled.
4. Shell/edit/test/task operations proceed while the same Goal ID/revision remains active.
5. `/goal audit` shows Todo telemetry as advisory and separate from the evidence ledger.
6. Editing the Goal makes prior Todo telemetry stale; subsequent work rebuilds/updates the plan for the new revision.
7. A real user message still pauses/steers autonomous Goal continuation.
8. Marking every Todo `completed` does not by itself complete the Goal.
9. If a hidden acceptance requirement is still failing, `opencode_goal_complete` remains rejected.
10. The Goal completes only when the normal host checks, current file evidence, independent semantic verifier, and requirement-by-requirement completion audit all pass.

## Deterministic repository gates

The repository tests cover:

- deterministic Todo normalization/digest/counting;
- no evidence or host-progress credit from Todo planning;
- no persistence churn for an identical plan rewrite;
- exact assistant-turn ownership;
- stale Goal-revision and pause races;
- stale-plan visibility after Goal edit;
- Todo binding invalidation on archived Goal restore;
- continuation/compaction scope rules;
- read-only `/goal audit` Todo visibility;
- mandatory adversarial eval cases for the Todo/Goal boundary.

These deterministic gates make the branch safe to hand to a real-model OpenCode test. The real-host test remains necessary to evaluate whether a selected model actually uses the native planning tool well on broad repository objectives.
