# Competitive semantic action adapters

Stateful competitors often expose different command syntax for the same lifecycle concept. Competitive scenarios should not solve that by giving each plugin a semantically different prompt. The benchmark instead uses a canonical action payload and a small, reviewable syntax mapping per competitor.

This layer changes **syntax only**. The external scenario oracles remain the only success authority.

## Canonical action

A stateful step may use a JSON prompt such as:

```json
{"action":"enqueue","objective":"create order.log containing exactly one line first and nothing else"}
```

or a higher-level lifecycle action:

```json
{
  "action": "start_sequence",
  "first": "create order.log containing exactly one line first and nothing else",
  "second": "append exactly one new line second after first in order.log without changing the first line or adding other content"
}
```

Canonical action values are JSON primitives. Nested objects/arrays are rejected so a mapping cannot hide another instruction structure inside a competitor-specific payload.

The canonical action should describe the capability being compared, not one plugin's internal API. For example, `start_sequence` means "start this strict ordered two-objective workflow". It does **not** mean "call `/goal add` twice and then `/goal next`"; that is only one implementation's syntax.

## Adapter mapping

A competitor adapter is versioned JSON. An action may map to one raw command template, a fail-fast sequence of templates, or an explicit unsupported declaration:

```json
{
  "schemaVersion": 1,
  "commandName": "goal",
  "actions": {
    "create": "{objective}",
    "start_sequence": [
      "add {first}",
      "add {second}",
      "next"
    ],
    "some_other_capability": {
      "unsupported": "The audited command surface does not expose this capability."
    }
  }
}
```

For the same canonical action, only syntax may change between competitors. Template fields are substituted into raw OpenCode command arguments; no shell is invoked by the adapter.

A command sequence runs in order in the same isolated benchmark session. If any subcommand fails, later subcommands are not executed. An `unsupported` declaration fails visibly with `BENCHMARK_CAPABILITY_UNSUPPORTED`; the case remains in the matrix and is not silently removed.

Missing actions, empty command sequences, unsupported declarations without a reason, and missing template fields all fail closed.

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

The adapter materializes the plugin's command syntax, then delegates to the shared stateful OpenCode runner so every command in that benchmark run stays in the same isolated OpenCode session.

## Current mappings

`benchmarks/adapters/opencode-goals.json` maps the stable OpenCode Goals 1.2 single-action surface. `benchmarks/ordered-sequence.semantic.pilot.json` remains a **single-plugin wiring pilot**, not ranking evidence.

### Verified OpenCode Goals artifact

The benchmark's OpenCode Goals entry uses the public npm artifact **`@bybrawe/opencode-goal@1.2.0`**. Its npm package page was manually verified as **Public / 1.2.0** on 2026-08-10. This exact version is therefore the release artifact to pin for cross-plugin benchmark runs; do not silently substitute a local checkout or a moving tag when producing comparable results.

The cross-plugin ordered-sequence example uses a higher-level `start_sequence` action and dedicated audited mappings:

- `opencode-goals-sequence.json`: OpenCode Goals implements the semantic action as `add {first}`, `add {second}`, then `next`.
- `willytop8-sequence.json`: `opencode-goal-plugin@0.6.5`, audited against repository ref `v0.6.5`, exposes native `/goal sequence ...; ...` syntax.
- `prevalentware-sequence.json`: `@prevalentware/opencode-goal-plugin@0.4.10` is kept in the matrix with an explicit unsupported declaration because the audited public command surface exposes no ordered-sequence command. The syntax audit commit is recorded in the adapter rather than inventing substitute multi-goal semantics.

`benchmarks/ordered-sequence.cross-plugin.example.json` pins OpenCode `1.17.15`, exact plugin versions, five repeats, one shared fixture, one canonical step, and the same external final oracle. Model/provider values remain placeholders on purpose; benchmark preflight must reject the example until they are replaced with exact values and the required provider environment is present.

The example is reproducible benchmark **wiring**, not a published result. Do not claim a ranking until the exact host/model/provider environment has been pinned and the repeated matrix has actually run.

## Adding competitors fairly

Before adding another plugin:

1. pin an exact npm version or immutable commit;
2. derive its command syntax from documentation/source corresponding to that pinned artifact whenever possible;
3. record source/ref metadata with the mapping when the package/source relationship is not self-evident;
4. normalize at the semantic capability level before writing syntax templates;
5. keep the canonical objective bytes identical across competitors;
6. keep the same scenario fixture, model/provider/OpenCode version, repeats, timeouts, permission policy, and external oracles;
7. make unsupported actions explicit instead of deleting hard cases from that competitor's matrix.

A mapping should never insert extra success hints, implementation advice, constraints, or verification instructions that are absent from the canonical action. If a competitor needs materially different semantics rather than different syntax, that is a capability difference and should remain visible in the score.
