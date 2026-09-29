# Native unit-handoff unload boundary

An admission, native resume, store read, or store write that started while the
plugin was alive can settle after unload. The retired instance must not start
another host request, retire the source owner, activate a target, or erase a
prepared target based on that late result. Handoff paths now re-check plugin
cancellation after asynchronous boundaries and before the next side effect.

Pending admission remains prepared with its existing durable inbox ID. A late
transport failure after unload is not permission to delete the target. An
already-persisted terminal source stays terminal; target activation is left to
a fresh instance. A resume that already started is not interrupted and its late
result does not authorize a new dispatched-state write by the retired instance.
A fresh instance recovers through the existing state machine and the same inbox
ID, without resetting Goal identity, revision, evidence, budgets, cumulative
usage, or the revision turn baseline. No schema change is required.

This is not cancellation of native model/tool/compaction execution. An in-flight
host operation or atomic persistence write may still finish. A session creation
already accepted by the host may leave an unused empty native session if unload
occurs before its Goal target is recorded; it is never resumed by the retired
instance. The guards do not claim to redesign crash recovery or cancel host IO.

`test/opencode2-handoff-lifetime.test.mjs` holds actual admission, rejection,
resume, and source-terminal persistence boundaries. It waits for the Goal lease
to release, checks for no post-unload host/persistence side effects, then loads
a fresh plugin and proves same-ID recovery and unchanged cumulative accounting.
The tests run through the shipped server entry, not a copied handoff algorithm.

The real three-session canary now uses an objective longer than the reminder
preview plus a separate constraint. It checks full model-visible messages, not
just the latest user-role message: the native context hook already carries the
complete persisted contract. A short reminder alone is not a context-loss bug.
This is deterministic provider contract coverage, not a live-model benchmark.
