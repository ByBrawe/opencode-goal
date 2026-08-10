# Competitive semantic action adapters

Stateful competitors often expose different command syntax for the same lifecycle concept. Competitive scenarios should not solve that by giving each plugin a semantically different prompt. The benchmark instead uses a canonical action payload and a small, reviewable syntax mapping per competitor.

This layer changes **syntax only**. The external scenario oracles remain the only success authority.

## Canonical action

A stateful step may use a JSON prompt such as:

```json
{"action":"enqueue","objective":"create order.log containing exactly one line first and nothing else"}
```

or an action with no text payload:

```json
{"action":"advance"}
```

Canonical action values are JSON primitives. Nested objects/arrays are rejected so a mapping cannot hide another instruction structure inside a competitor-specific payload.

## Adapter mapping

A competitor adapter is versioned JSON:

```json
{
  "schemaVersion": 1,
  "commandName": "goal",
  "actions": {
    "create": "{objective}",
    "enqueue": "add {objective}",
    "inspect_queue": "queue",
    "advance": "next"
  }
}
```

For the same canonical `enqueue` step, only the template changes between competitors. `{objective}` is substituted as an argv value inside the raw OpenCode command arguments. No shell is invoked by the adapter.

Missing actions and missing template fields fail closed. They are not silently removed from the scenario matrix.

## Runtime command

A competitor can route canonical actions through:

```json
[
  "node",
  "{root}/scripts/benchmark/semantic-action-adapter-cli.mjs",
  "{root}/benchmarks/adapters/opencode-goals.json",
  "{prompt}"
]
```

The adapter materializes the plugin's command syntax, then delegates to the shared stateful OpenCode runner so every action in that benchmark run stays in the same isolated OpenCode session.

## Current mapping

`benchmarks/adapters/opencode-goals.json` maps the stable OpenCode Goals 1.2 command surface. `benchmarks/ordered-sequence.semantic.pilot.json` uses only canonical `enqueue` and `advance` actions and the same external worktree oracles as the raw-syntax pilot.

The semantic pilot is still **single-plugin wiring evidence only**. It must not be presented as a cross-plugin ranking.

## Adding competitors fairly

Before adding another plugin:

1. pin an exact npm version or commit;
2. derive its command syntax from current primary documentation/source;
3. record only the minimal syntax mapping needed for the canonical actions;
4. keep the canonical objective bytes identical across competitors;
5. keep the same scenario fixture, model/provider/OpenCode version, repeats, timeouts, and external oracles;
6. make unsupported actions explicit instead of deleting hard cases from that competitor's matrix.

A mapping should never insert extra success hints, implementation advice, constraints, or verification instructions that are absent from the canonical action. If a competitor needs materially different semantics rather than different syntax, that is a capability difference and should remain visible in the score.
