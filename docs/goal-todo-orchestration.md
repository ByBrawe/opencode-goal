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

## Deterministic real-host canary

`scripts/host-todo-canary.mjs` runs against a real OpenCode server with a local deterministic OpenAI-compatible provider, so it spends no model quota. The provider forces the real Build agent to call its native `todowrite` tool and the canary verifies the resulting Goal snapshot.

The canary requires all of these conditions at once:

- the real Build agent exposes `todowrite`;
- the continuation contains the Goal/Todo orchestration guidance;
- exactly one real native Todo call creates a three-item plan for the current Goal revision;
- `progressRevision` and `observedProgressRevision` remain zero;
- no evidence or requirement proof is created by Todo planning;
- the Goal remains unfinished until explicitly paused by the canary.

The PR CI runs this canary on both Ubuntu and Windows immediately before the existing semantic completion canary. The current model-test template pins OpenCode `1.18.16`, the exact host version exercised successfully by this branch's deterministic canary. Changing that host pin requires rerunning the complete repository gates.

## Model-driven benchmark stage

The model test uses `benchmarks/goal-todo-orchestration.model.example.json`. It does **not** use the published `1.2.0` plugin. Scenario setup writes a disposable local plugin shim that imports the current checkout's built `dist/index.js`, so the test exercises the feature branch itself.

The fixture begins red: implementation behavior is wrong and `STATUS.md` is `NOT READY`. Its hidden oracle lives outside the copied workspace and requires all of the following before a run can pass:

- the documented public behavior and visible tests are correct;
- frozen README/package/test contracts were not changed;
- `STATUS.md` is exactly `READY`;
- hidden behavior cases pass;
- the persistent Goal is actually `completed` with every requirement proven and verifier-backed evidence present;
- real file work produced host-observed progress;
- native Todo telemetry belongs to the current Goal revision, has at least three completed items, and has zero pending/in-progress items.

Prepare the checkout without publishing anything:

```text
npm install
npm run build
npm install --no-save --package-lock=false opencode-ai@1.18.16
```

Copy the example manifest and replace `PIN_EXACT_PROVIDER_MODEL` and `PIN_PROVIDER_NAME`. The example passes only `OPENAI_API_KEY`; if another provider is used, replace `passEnv`/`requiredEnv` with the minimum credential names that provider needs.

```text
cp benchmarks/goal-todo-orchestration.model.example.json benchmarks/goal-todo-orchestration.model.json
```

Validate everything before spending model quota:

```text
node scripts/competitive-benchmark.mjs \
  --manifest benchmarks/goal-todo-orchestration.model.json \
  --preflight \
  --out benchmark-results/todo-orchestration
```

Inspect the selected matrix:

```text
node scripts/competitive-benchmark.mjs \
  --manifest benchmarks/goal-todo-orchestration.model.json \
  --dry-run
```

Then run the three-repeat real-model test:

```text
node scripts/competitive-benchmark.mjs \
  --manifest benchmarks/goal-todo-orchestration.model.json \
  --out benchmark-results/todo-orchestration
```

The files to retain for analysis are `benchmark-results/todo-orchestration/report.json` and `report.md`. Use `--keep-workspaces` only for debugging a failure because successful and failed normal runs are otherwise disposable.

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
- mandatory adversarial eval cases for the Todo/Goal boundary;
- the broad-project model fixture's red/pass/incomplete-Todo oracle geometry;
- local feature-branch plugin installation for disposable benchmark workspaces.

These deterministic gates plus the real-host native Todo canary make the branch safe to hand to a selected real model. The model-driven benchmark remains necessary to evaluate whether that model performs good reconnaissance, maintains the plan throughout real edits/tests, and reconciles native Todos before verified Goal completion.
