# Native OpenCode 2 lifecycle audit

This supplements OPENCODE2-MIGRATION.md. It is a source/main audit batch,
not a new npm publication or a claim that every migration phase is complete.

## Official references

- Plugin migration: https://opencode.ai/v2/docs/build/plugins/migrate-v1
- Exact host contract: anomalyco/opencode tag v2.0.18.

The dedicated migration guide distinguishes retryable prompt admission from
model context and compaction hooks. Public event subscriptions belong to the
plugin: pass an AbortSignal and terminate them from the cleanup returned by
setup. Hook and transform registrations remain scoped to the host plugin.

## Goal setup rollback and cleanup

Goal now installs its resource cleanup before starting the event subscriber.
If a later command or tool registration rejects, setup aborts and drains that
subscriber before rethrowing the original registration error. The host cannot
call a returned disposer when setup has failed before returning it.

Concurrent and repeated disposal share one promise. Abort is published before
cleanup awaits the subscriber. Events received after abort are ignored, and
retry scheduling and queued continuation wake-ups check the disposed state.
The existing project-local store, Goal IDs, revisions, evidence, budgets and
native compaction ownership are unchanged.

`test/opencode2-setup-cleanup.test.mjs` covers command registration failure,
tool registration failure, and normal/concurrent/repeated unload. All three
regressions failed against the original source in candidate run 36498887642.
The corrected Ubuntu candidate passed 428 tests, with two platform-specific
skips and no failures, the 182/182 weighted adversarial evaluation, and the
production tarball smoke test. Matrix and final-main CI are the authoritative
records for other platforms and the combined tree.

## Concurrent process cleanup work

This change preserves the separate unit-command process-tree correction in
08c54b5c28b6e811713a4dc01b22f68d2bb2400c, its tests and migration-plan edits.
That work terminates plugin-spawned commands; this batch cancels public event
subscriptions. Neither mechanism is a request to abort a native OpenCode
model, tool or compaction execution. The combined main tree must pass its own
regression, package and real-host checks.

Remaining feature parity, handoff/restart coverage and release acceptance stay
tracked in OPENCODE2-MIGRATION.md rather than being inferred from issue closure.
