# Competitive benchmark harness

The competitive benchmark is a developer-only CLI harness. It is deliberately separate from the OpenCode Goals runtime so benchmark orchestration cannot become part of completion policy or persisted Goal state.

## Principles

- Run every competitor from the same manifest, scenario fixture, repeat count, timeout, OpenCode version, and explicitly passed model/provider environment.
- Copy each scenario into a fresh temporary workspace and give every run an isolated HOME/XDG state directory.
- Treat the agent process as an executor only. A run passes **only** when the independent scenario oracle exits with code 0.
- Commands are argv arrays and are spawned with `shell: false`; prompts are never interpolated into a shell command string.
- Force-kill the executor process tree on timeout and perform best-effort descendant cleanup after normal exit so leaked OpenCode/server/background children do not contaminate later runs.
- Child processes inherit only a small platform environment plus names explicitly listed in `passEnv`. Repository/npm credentials are therefore not inherited accidentally.
- Values selected by `passEnv`/`redactEnv`, plus obviously secret-looking manifest environment keys, are redacted from stored command/output tails.
- Pin OpenCode, plugins, competitors, models, and providers so the same manifest is reproducible later.
- Committed benchmark fixtures are normalized to LF through `.gitattributes`, keeping frozen byte contracts identical on Windows and Unix hosts.

## Usage

Start from `benchmarks/competitive.example.json`, replace every `PIN_...` / competitor placeholder with exact values, then run the no-model preflight first:

```text
node scripts/competitive-benchmark.mjs --manifest benchmarks/competitive.json --preflight --out benchmark-results
```

Preflight fails before model spend when required provider environment is missing, a command executable cannot be resolved, an npm plugin is not pinned to an exact semver, reproducibility metadata still contains placeholders, a fixture cannot be hashed, or a declared baseline oracle starts in the wrong state. It writes `preflight.json` and `preflight.md`.

Then inspect the run matrix without spending model quota:

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

Use `--keep-workspaces` only when debugging a failure. The default removes disposable run directories after collecting the final redacted stdout/stderr tails and oracle result.

## Running OpenCode commands headlessly

Current OpenCode `run` supports `--command`, so a competitor can invoke its goal command non-interactively instead of sending `/goal ...` as ordinary prompt text. The OpenCode Goals example therefore uses:

```json
["opencode", "run", "--command", "goal", "{prompt}"]
```

If another plugin uses a different command name, change only that competitor's argv. Keep the scenario prompt itself identical across competitors.

Do not enable broad auto-approval merely to make the benchmark easier to run. Permission policy is part of the test environment, especially for the future dangerous-shell category.

## Isolated competitor configuration

A competitor may define `opencodeConfig`. Before each run the harness writes that object to the run's isolated global OpenCode config at `~/.config/opencode/opencode.json` (under the disposable HOME).

For stable OpenCode plugins this lets the manifest pin an npm plugin without reading the operator's real OpenCode config:

```json
{
  "opencodeConfig": {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["@bybrawe/opencode-goal@1.2.0"]
  }
}
```

OpenCode resolves npm plugins from config at startup. Use exact versions for real comparison runs. A competitor may also define an optional `setup.command` for additional per-run preparation; setup is executed inside the disposable workspace/HOME before scenario setup and the agent.

## Manifest

`competitors[].command`, optional `competitors[].setup.command`, `scenarios[].setup.command`, and `scenarios[].oracle.command` are argv arrays. Supported placeholders are `{root}`, `{workspace}`, `{home}`, `{prompt}`, `{competitor}`, `{scenario}`, and `{run}`.

The harness supports per-scenario weights. A competitor's headline score is the weighted fraction of oracle-passing runs, while the report also includes raw pass rate and category-level weighted scores. Optional top-level `metadata` is copied into the report for non-secret reproducibility fields such as exact OpenCode version, model, and provider; secret-looking metadata keys are rejected.

`passEnv` is an allowlist. Add only provider/model variables that the selected OpenCode setup actually needs. `requiredEnv` is a separate preflight requirement list; use it for keys that must be present before a run can start. Do not pass GitHub/npm credentials to third-party competitor runs. `passEnv` values are automatically redacted from reports; use `redactEnv` for additional names that must never be persisted in benchmark output.

A scenario may set `preflightOracle` to `"fail"`, `"pass"`, or `"skip"`. The committed adversarial fixtures use `"fail"`: if an oracle is already green before the agent touches the workspace, that benchmark case is invalid and preflight blocks the run.

## Included deterministic fixtures

The repository now ships three model-independent fixtures with hidden oracles outside the disposable workspaces:

- `normal-completion`: starts with genuinely failing arithmetic tests; the oracle requires the original test contract to remain byte-for-byte unchanged and then requires the tests to pass.
- `false-complete-trap`: the visible test is green at the start, while hidden acceptance cases are still red. This catches systems that treat a narrow visible check or executor narration as sufficient proof.
- `constraint-preservation`: the implementation is broken but `src/public-api.js` is a frozen boundary. The oracle requires the behavioral fix while rejecting any change to the public API file or test contract.

`test/competitive-fixtures.test.mjs` proves the intended red/green shape of these fixtures without a model: each bad initial state fails, the intended fix passes, and the constraint fixture rejects deliberate API tampering.

## Reports

Every completed matrix writes:

- `report.json`: machine-readable run records, setup/agent/oracle exit codes, timeouts, durations, redacted output tails, oracle results, manifest SHA-256, per-run fixture SHA-256, non-secret metadata, and weighted summaries;
- `report.md`: ranking, category scores, pass rates, and a concise failure index with the oracle's final diagnostic when available.

An agent saying "done", returning exit code 0, or printing a green-looking message is never counted as success by itself.

## Next corpus layers

The next fixtures should exercise stateful and adversarial dimensions that need more than one simple executor call: fake evidence, stale evidence after mutation, Plan escape, user-takeover race, delegated/background work, hard process crash, two-process state race, corrupt state, storage path escape, multi-goal workflow, and dangerous-shell behavior.

Those cases should remain visible even when a competitor does not support the feature. Category-level reporting is intended to show breadth versus correctness/safety/durability rather than silently removing hard scenarios.
