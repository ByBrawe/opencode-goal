# OpenCode 2 control-state evidence boundary

The native unit-handoff implementation stores process leases in
`.opencode/goal-handoff-locks`. These files belong to the plugin control plane,
just like `.opencode/goals`, `.opencode/goal-locks`, `.opencode/goal-sequences`
and the companion `.opencode/opencode-loop` scheduler state.

Lease creation, renewal, or deletion must not masquerade as coding progress.
The shared Goal path classifier now includes the native handoff root. This
preserves its existing use by file-mutation and patch-event progress filters.
It does not change Goal IDs, revision, budget, evidence or persistence formats.
User-owned `.opencode/commands` and similarly named non-control directories
remain eligible project work; this is not a blanket exclusion of `.opencode`.

Regression: `test/opencode2-handoff-control-plane.test.mjs` covers five native
lease path forms (relative, absolute, Windows separators and case/slash
normalization), existing roots and narrow false-positive boundaries.
Against original source blob 9fe4d239162e4905e545409052f36458c9d1f55e,
five of six focused tests failed. With the added root all six passed under
Node 22.16.0 after strict TypeScript compilation. Full repository and host
CI remain independent gates; no npm publication is implied.

Companion Loop audit: a Goal contract or archived state containing a Loop
`--until` string is not evidence that the Loop task finished. Loop's recursive
marker scan must exclude these same control roots while preserving its
explicit `.opencode/opencode-loop/until.txt` opt-in completion marker.
See the Loop control-plane scanner regressions for that independent boundary.
