# Stateful competitive benchmark scenarios

The competitive benchmark supports stateful scenarios when one final executor call is not enough to expose the behavior being measured. Ordered Goal sequences, user-takeover races, restart workflows, and other lifecycle tests can use `scenario.steps` while preserving the same disposable workspace/HOME for the whole run.

This is a benchmark orchestration feature only. It does not participate in OpenCode Goals runtime state, completion policy, or production persistence.

## Scenario shape

A legacy scenario keeps its single `prompt` and final oracle. A stateful scenario replaces `prompt` with a non-empty ordered `steps` array:

```json
{
  "id": "ordered-workflow",
  "category": "workflow",
  "weight": 5,
  "workspace": "benchmarks/fixtures/example",
  "steps": [
    {
      "id": "first",
      "prompt": "first command arguments",
      "oracle": {
        "command": ["node", "{root}/benchmarks/oracles/first-state.mjs", "{workspace}"],
        "expect": "pass"
      }
    },
    {
      "id": "second",
      "prompt": "second command arguments",
      "oracle": {
        "command": ["node", "{root}/benchmarks/oracles/second-still-inert.mjs", "{workspace}"],
        "expect": "fail"
      }
    }
  ],
  "oracle": {
    "command": ["node", "{root}/benchmarks/oracles/final-state.mjs", "{workspace}"]
  }
}
```

Each step reuses the competitor's normal argv template and substitutes that step's `prompt`. `{step}` is also available as a command-template variable.

`oracle.expect` defaults to `pass`. `expect: "fail"` is useful for negative invariants such as "the second queued Goal must not have executed yet". The oracle process itself remains authoritative: exit 0 means PASS and non-zero means FAIL; `expect` declares which of those states is correct at that exact boundary.

## Failure semantics

Agent process exit code is still not proof of success. After a step completes, its intermediate oracle is evaluated when declared.

If an intermediate oracle does not match its expected state, the benchmark stops executing later agent steps. The final oracle still runs for diagnostics when infrastructure is healthy, but the run remains failed even if the final state later looks green. This prevents a later step from repairing or hiding an earlier ordering/safety violation.

A run passes only when:

1. benchmark setup had no infrastructure failure;
2. every declared intermediate oracle matched its expected state; and
3. the final scenario oracle passed.

JSON reports include `agentSteps`, `stepOracles`, and `stepFailure`. Markdown failure output identifies the failed step invariant separately from a final-oracle failure.

## Keeping one OpenCode session across steps

Stateful Goal behavior is session-scoped, so sharing only the workspace is insufficient. Use the repository's shared OpenCode wrapper as the competitor command:

```json
[
  "node",
  "{root}/scripts/benchmark/opencode-stateful-run.mjs",
  "goal",
  "{prompt}"
]
```

The wrapper launches the first step with `opencode run --command <name> ...`. Later invocations in the same disposable benchmark HOME use `opencode run --continue --command <name> ...`, so they target the latest session created for that isolated run. A different benchmark HOME starts fresh.

`OPENCODE_BIN` may point the wrapper at a pinned OpenCode executable. The wrapper never invokes a shell and preserves the benchmark's existing isolated environment.

## Preflight

Stateful scenarios remain model-free during `--preflight`. Preflight validates the final oracle executable, every intermediate oracle executable, fixture digest, required environment, competitor executable, and the declared final baseline oracle state. It does not run agent steps.

## Ordered-sequence pilot

`benchmarks/ordered-sequence.pilot.json` is a **single-plugin wiring pilot**, not cross-plugin competitive evidence. It pins OpenCode Goals `1.2.0` and exercises one observable sequence outcome:

1. queue a Goal that must eventually create `order.log` containing exactly `first\n`;
2. independently prove that `order.log` still does not exist;
3. queue a second Goal that must append exactly `second\n` after the first line;
4. independently prove the worktree is still untouched;
5. explicitly activate the queue head with `/goal next`;
6. require the final worktree to contain exactly `first\nsecond\n`.

The pilot therefore measures inert pending contracts, ordered execution, and automatic continuation into the second queued Goal through an external worktree oracle. It never reads OpenCode Goals' internal queue JSON to award success.

Run its model-free wiring check first:

```text
node scripts/competitive-benchmark.mjs \
  --manifest benchmarks/ordered-sequence.pilot.json \
  --preflight \
  --out benchmark-results/ordered-sequence-pilot
```

Then run the three-repeat pilot only with the required provider environment and an exact OpenCode setup:

```text
node scripts/competitive-benchmark.mjs \
  --manifest benchmarks/ordered-sequence.pilot.json \
  --out benchmark-results/ordered-sequence-pilot
```

Do not use this pilot score in competitor ranking claims. The committed cross-plugin case must wait for the fairness layer below so each plugin receives the same semantic lifecycle actions even when command syntax differs.

## Fair competitor syntax

Different Goal plugins may expose different command syntax for semantically equivalent lifecycle actions. Do not encode competitor-specific semantic advantages inside scenario prompts. Keep the scenario's intended state transitions identical and make syntax translation explicit and reviewable in the benchmark manifest or a thin competitor adapter.

The next harness layer will standardize those lifecycle action adapters before the ordered-sequence competitor scenario is promoted to the committed comparison corpus.
