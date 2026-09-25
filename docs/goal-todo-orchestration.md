# Goal Todo orchestration

OpenCode Goals treats a Goal and Todo planning as two different layers:

- **Goal**: the persistent user-authorized outcome, constraints, requirements, budgets, and completion proof boundary.
- **Todo plan**: advisory execution-planning state used to organize concrete work toward that Goal.

On V1, Goal observes OpenCode's native `todowrite` state. Exact packaged OpenCode 2.0.11 and 2.0.15 do not materialize `todowrite` into the provider tool list, including on a stock host with no Goal plugin. When that native tool is absent, the V2 adapter may expose `opencode_goal_todo_plan` only to the exact Goal-owned execution as a transparent advisory fallback. If native `todowrite` is present, the fallback is hidden automatically so there is never more than one live planning authority.

Todo state is never copied into the Goal requirement ledger and never becomes completion evidence.

## Intended broad-Goal flow

A user should be able to start with a short objective such as:

```text
/goal analyze this project, identify incomplete required work, and finish it
```

For a broad/discovery-shaped Goal, the active agent should:

1. inspect enough current repository/external state to understand the existing product scope;
2. derive concrete work that is actually required by the Goal, repository policy, current tests/docs, or declared constraints;
3. use OpenCode's native `todowrite` tool when it is available and permitted; otherwise, if the V2 Goal-owned fallback is exposed, use `opencode_goal_todo_plan` for the same advisory planning role;
4. keep at most one Todo item `in_progress`, updating items when work actually starts or finishes;
5. add newly discovered work only when current evidence shows it is required by the already-authorized Goal scope;
6. use normal read/edit/write/shell/test/task tools to perform the work while the Goal remains unchanged;
7. reconcile the Todo plan before completion, but treat Todo status only as planning state;
8. call Goal completion only after the full objective and every required criterion/constraint are proven by the existing host/verifier audit pipeline.

Assistant-generated nice-to-haves, unrelated cleanup, speculative improvements, or follow-up suggestions do not become authorized work merely because they can be added to a Todo list.

## Persistence and ownership model

OpenCode remains the live owner when a native Todo list exists. When the packaged V2 host does not expose native `todowrite`, only the exact Goal-owned execution may update the fallback plan. In both cases OpenCode Goals persists a **revision-bound advisory snapshot** so long plans can survive restart/compaction without reducing the work plan to aggregate counts.

The persisted Todo snapshot contains:

- the Goal revision that observed the plan;
- a deterministic plan digest;
- pending / in-progress / completed / cancelled counts;
- observation time;
- exact Todo item text, status, priority, order, and optional native Todo id;
- a deterministic Goal-owned item key that remains stable across status transitions.

This durable item manifest is recovery/reconciliation data only. It is not a requirement ledger or completion authority. The snapshot records its source as `native` or `goal_fallback`; older snapshots with no source remain valid and are interpreted as native. A later native Todo observation outranks and upgrades an identical fallback snapshot, while fallback state can never downgrade a native snapshot.

Native `todo.updated` state or a fallback plan update is attached to Goal telemetry only when it belongs to the exact current assistant Goal turn (`goalID + revision`). A stale, foreground, read-only, verifier, or post-pause update is ignored.

Editing a Goal keeps the prior Todo snapshot visible as **STALE** so continuation can rebuild the plan for the new revision. An unchanged replay cannot silently bind that stale manifest to the new revision; a genuinely rebuilt/changed plan can bind current. Restoring an archived Goal still clears the old Todo binding because planning state may have changed while the Goal was archived.

Todo telemetry/manifest state:

- does **not** increment `progressRevision`;
- does **not** create evidence records;
- does **not** prove requirements;
- does **not** authorize scope changes;
- does **not** block Goal execution if native `todowrite` and/or the fallback planning tool are unavailable or denied.

## Restart and compaction recovery

Repeated autonomous continuation prompts intentionally do **not** re-append all Todo item text. They carry only the compact aggregate plan summary, preventing a 50-100+ item Todo list from recreating the long-context growth failure that Goal's bounded continuation prompts are designed to avoid.

When OpenCode compacts a Goal session, the persistent compaction context re-anchors a bounded rendering of the durable Todo manifest together with the Goal contract. If the manifest is larger than the context budget, the full item list remains persisted in Goal state while the model-facing compaction block explicitly reports that additional items were omitted to keep context bounded.

The worktree remains authoritative for execution evidence. Native Todo state is authoritative when the host exposes it; otherwise the revision-bound Goal fallback is only advisory recovery context. The persisted manifest exists to recover the last observed plan after restart/compaction and to make stale/current revision ownership visible; it is not proof that any task was performed.

## Deterministic real-host canaries

The V1 canary `scripts/host-todo-canary.mjs` still proves native `todowrite` behavior on its pinned stable V1 host.

For V2, a stock-vs-Goal diagnostic canary proved that exact packaged OpenCode 2.0.15 omits `todowrite` from both provider tool lists; Goal did not remove it. The V2 fallback canary therefore proves that a real Goal-owned autonomous turn receives `opencode_goal_todo_plan` only when native `todowrite` is absent, and that the resulting snapshot is explicitly tagged `goal_fallback`.

The V2 fallback canary requires all of these conditions at once:

- the first Goal-owned autonomous provider request does **not** expose native `todowrite`;
- it does expose `opencode_goal_todo_plan`;
- the direct lifecycle mutation tool remains hidden during Goal work;
- exactly one fallback call creates a current-revision multi-item plan tagged `goal_fallback`;
- `progressRevision` remains unchanged and no evidence/requirement proof is created;
- the Goal remains active and unfinished after planning.

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
6. Editing the Goal makes prior Todo telemetry/manifest stale; subsequent work rebuilds/updates the plan for the new revision.
7. A real user message still pauses/steers autonomous Goal continuation.
8. Marking every Todo `completed` does not by itself complete the Goal.
9. If a hidden acceptance requirement is still failing, `opencode_goal_complete` remains rejected.
10. The Goal completes only when the normal host checks, current file evidence, independent semantic verifier, and requirement-by-requirement completion audit all pass.

## Deterministic repository gates

The repository tests cover:

- deterministic Todo normalization/digest/counting;
- durable item-level text/status/order/native-id persistence for 100-item plans;
- stable Goal-owned Todo item identity across status transitions;
- schema-v1 aggregate-only snapshot compatibility and automatic manifest upgrade;
- no evidence or host-progress credit from Todo planning;
- no persistence churn for an identical plan rewrite;
- exact assistant-turn ownership;
- stale Goal-revision and pause races;
- stale-plan visibility after Goal edit and unchanged-replay rejection;
- Todo binding invalidation on archived Goal restore;
- bounded compaction manifest recovery without repeated continuation bloat;
- read-only `/goal audit` Todo visibility;
- mandatory adversarial eval cases for the Todo/Goal boundary;
- the broad-project model fixture's red/pass/incomplete-Todo oracle geometry;
- local feature-branch plugin installation for disposable benchmark workspaces.

These deterministic gates plus the real-host native Todo canary make the branch safe to hand to a selected real model. The model-driven benchmark remains necessary to evaluate whether that model performs good reconnaissance, maintains the plan throughout real edits/tests, and reconciles native Todos before verified Goal completion.
