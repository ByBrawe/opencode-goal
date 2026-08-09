# Competitive benchmark harness

The competitive benchmark is a developer-only CLI harness. It is deliberately separate from the OpenCode Goals runtime so benchmark orchestration cannot become part of completion policy or persisted Goal state.

## Principles

- Run every competitor from the same manifest, scenario fixture, repeat count, timeout, and explicitly passed model/provider environment.
- Copy each scenario into a fresh temporary workspace and give every run an isolated HOME/XDG state directory.
- Treat the agent process as an executor only. A run passes **only** when the independent scenario oracle exits with code 0.
- Commands are argv arrays and are spawned with `shell: false`; prompts are not interpolated into a shell command string.
- Child processes inherit only a small platform environment plus names explicitly listed in `passEnv`. Repository/npm credentials are therefore not inherited accidentally.
- Pin OpenCode, plugins, competitors, models, and providers outside the harness so the same manifest is reproducible later.

## Usage

Start from `benchmarks/competitive.example.json`, replace the placeholder competitor commands and fixture paths, then inspect the run matrix without spending model quota:

```text
node scripts/competitive-benchmark.mjs --manifest benchmarks/competitive.json --dry-run
```

Run the full matrix:

```text
node scripts/competitive-benchmark.mjs --manifest benchmarks/competitive.json --out benchmark-results
```

Focus one competitor or scenario while debugging:

```text
node scripts/competitive-benchmark.mjs --manifest benchmarks/competitive.json --competitor opencode-goals
node scripts/competitive-benchmark.mjs --manifest benchmarks/competitive.json --scenario false-complete-trap
```

Use `--keep-workspaces` only when debugging a failure. The default removes disposable run directories after collecting the final stdout/stderr tails and oracle result.

## Manifest

`competitors[].command`, `scenarios[].setup.command`, and `scenarios[].oracle.command` are argv arrays. Supported placeholders are `{workspace}`, `{prompt}`, `{competitor}`, `{scenario}`, and `{run}`.

The harness supports per-scenario weights. A competitor's headline score is the weighted fraction of oracle-passing runs, while the report also includes raw pass rate and category-level weighted scores.

`passEnv` is an allowlist. Add only provider/model variables that the selected OpenCode setup actually needs. Do not pass GitHub/npm credentials to third-party competitor runs.

## Reports

Every completed matrix writes:

- `report.json`: machine-readable run records, exit codes, timeouts, durations, output tails, oracle results, and weighted summaries;
- `report.md`: ranking, category scores, pass rates, and a concise failure index suitable for sharing back into a review conversation.

An agent saying "done", returning exit code 0, or printing a green-looking message is never counted as success by itself.

## Recommended first corpus

Build fixtures/oracles for these independent dimensions before publishing comparative claims: normal completion, false-complete trap, hard constraint preservation, fake evidence, stale evidence, Plan escape, user-takeover race, delegated/background work, hard process crash, two-process state race, corrupt state, storage path escape, multi-goal workflow, and dangerous-shell behavior.

Not every competitor is expected to support every product feature. Keep unsupported-feature outcomes visible instead of silently removing those scenarios; category-level reporting makes breadth versus safety/durability differences explicit.
