# Changelog

All notable changes to **OpenCode Goals** are documented here.

## 1.3.44 — 2026-10-02

OpenCode 2.0.22 SDK-contract and autonomous ownership recovery patch.

- Fix #261 by recovering a lost in-memory Goal execution owner only when public `session.context({ sessionID })` proves the latest persisted user message is the exact Goal-owned autonomous prompt for the same Goal id and revision.
- Fail closed when a newer ordinary user message exists, and deduplicate settled execution generations so a replayed terminal cannot dispatch a second continuation.
- Use the stable OpenCode 2 `session.interrupt({ sessionID })` contract without the legacy `continue` flag and add compile-time SDK conformance tripwires for interrupt, prompt and session-context inputs.
- Pin the production OpenCode 2 SDK/runtime dependency to exact `@opencode/plugin@2.0.22` and validate the native direct lifecycle against the latest OpenCode 2 host.
- Align optional OpenTUI peers and release/package smoke fixtures to 0.5.14, matching the 2.0.22 SDK peer graph without bypassing npm peer resolution.
- On Windows, wait for `taskkill /T /F` process-tree termination to finish propagating before a timed-out/overflowed Goal unit rejects, preventing pipe-detached descendants from mutating files after the terminal result.

Goal state schema, objective/constraint semantics, evidence, budgets, sequence ownership and V1 compatibility are unchanged.

See [the 1.3.44 release notes](docs/releases/1.3.44.md).

## 1.3.43 — 2026-10-02

OpenCode 2 configuration canonicalization and deterministic SDK release.

- Persist OpenCode 2's native plural `plugins` configuration without leaving a parallel legacy `plugin` block when valid legacy plugin specifications are present.
- Mirror OpenCode 2.0.21 normalization semantics: legacy strings remain strings and valid `[package, options]` tuples become native `{ package, options }` entries, preserving their order ahead of existing native registrations.
- Preserve malformed/unrecognized legacy plugin entries instead of deleting them, and keep unrelated provider/model configuration untouched.
- Pin the OpenCode 2 plugin runtime dependency to exact `@opencode/plugin@2.0.18` so npm's moving dependency graph cannot silently change the published runtime or release build.
- Add regressions for mixed legacy/native plugin configuration, JSONC comments and string values, multi-config installs, object options, idempotence and user-owned command preservation.

Goal identity, objective, constraints, revision, evidence, cumulative usage, budgets and handoff recovery are unchanged.

See [the 1.3.43 release notes](docs/releases/1.3.43.md).

## 1.3.42 — 2026-09-30

OpenCode 2 migration-guide conformance and public-context authority hardening release.

- Treat `ctx.location.directory` as the only plugin-instance project location; `ctx.options` remains plugin configuration and can no longer masquerade as location authority during startup recovery or capability probes.
- Keep per-session state resolution bound to public `session.get(...).location.directory`; missing session location still fails closed.
- Use the public V2 `session.interrupt({ sessionID, continue: false })` request for semantic-verifier timeout cleanup as well as lifecycle interruption.
- Retain native `plugins` installation, `Plugin.define({ id, setup })` entrypoints, command/tool/session hooks, abortable event subscriptions, explicit V1 compatibility subpaths, and host-owned compaction boundaries.
- Add regressions proving plugin options cannot supply project location authority and that verifier interruption uses the public V2 contract.

This patch preserves Goal identity, objective, constraints, revision, evidence, cumulative usage, budgets and same-ID handoff recovery.

See [the 1.3.42 release notes](docs/releases/1.3.42.md).

## 1.3.41 — 2026-09-30

OpenCode 2 public-session contract and location-safety hardening release.

- Use the documented V2 `session.interrupt({ sessionID, continue: false })` request shape for lifecycle mutations instead of the stale `resume` field.
- Resolve Goal state only from the target session returned by `session.get`; plugin-instance options are no longer accepted as proof of an arbitrary session's working directory.
- Keep the V2 package root isolated from V1-only modules through the explicit `./api` and `./v1` subpaths introduced in 1.3.40.
- Canonicalize project-root traversal before storage safety checks so Windows 8.3 aliases such as `RUNNER~1` do not falsely look outside the project while symlink/junction escapes remain rejected.
- Retain native sidebar, restart recovery, Todo differential, three-session handoff and Windows/Linux package gates before trusted publication.

This release changes no Goal identity, evidence, revision, handoff accounting or budget schema.

See [the 1.3.41 release notes](docs/releases/1.3.41.md).

## 1.3.40 — 2026-09-29

Official OpenCode 2 plugin-definition and package-contract hardening release.

- Define the package root and public `./server` entrypoint with `@opencode/plugin` `Plugin.define({ id, setup })`, move programmatic named exports to `./api` so the V2 root cannot eagerly instantiate V1 tool modules, and retain `./v1` as the explicit legacy function.
- Define the public `./v2` native-only entry with the same official V2 contract instead of a hand-written lookalike object.
- Define `./tui` with `@opencode/plugin/tui` `Plugin.define()`; keep the V1 TUI implementation lazy and separate.
- Preserve the official V2 Context at public boundaries and adapt only the existing narrower internal Goal host interfaces behind those boundaries.
- Verify server/RPC from a production install with peer dependencies omitted, then verify the TUI separately with the supported OpenTUI/Solid host peer set.
- Exercise the exact current Loop V2 companion source on OpenCode 2.0.18 before trusted npm publication.
- Run the required Experimental OpenCode 2 Host gate on every main push so exact-commit publication cannot be blocked by its own path filters.
- Keep Native Goal Sidebar main runs non-cancellable so an otherwise green exact-commit release gate cannot end as `cancelled`; superseded pull-request runs still cancel.

Goal identity, contract, revision, evidence, handoff recovery and cumulative budgets are unchanged from 1.3.39.

See [the 1.3.40 release notes](docs/releases/1.3.40.md).

## 1.3.39 — 2026-09-29

Native OpenCode 2 presentation and lifecycle hardening release.

- Add the native `setup(context)` terminal sidebar using the public V2 slot, session-data and RPC APIs. Retain lazy, explicitly separate V1 presentation compatibility.
- Publish the shared `@bybrawe/opencode-goal/rpc` contract and read-only server status projection. Bind reads to the verified session directory/workspace; never substitute unrelated client-local files for remote state.
- Bound sidebar polling and requests, coalesce event bursts, reject stale responses after session changes, surface unavailable/corrupt storage and release listeners on unload.
- Fence continuation and unit-handoff late results after plugin unload, roll back failed native setup, retain the same durable inbox identity for recovery, and preserve Goal identity, contract, revision, evidence and cumulative budgets.
- Terminate timed-out/overflowing unit-command process trees and exclude native handoff control-state changes from project progress.
- Strengthen three-session native handoff checks with a long objective and a separate constraint across complete model-visible context, without duplicating full prompts or resetting accounting.
- Require ten exact-main release gates, including native sidebar rendering, Windows/Linux installed-package checks and current-host/Todo-differential coverage. Reject stale successful runs and immutable npm version/source mismatches.
- Verify npm latest, source gitHead, exports, dependencies, installer identity and clean published native imports after trusted publication.

OpenCode 2.0.18 is the native sidebar/RPC and joint-host baseline. Handoff compatibility on 2.0.16 is tested separately. These are deterministic functional checks, not live-provider performance measurements or a claim that every future host and option is equivalent. In-flight host IO may finish after unload; the retired plugin cannot initiate the next handoff side effect.

The previously published 1.3.38 package belongs to commit `2c21251d65e0f2c2df291f76bd4e92e325934b46`; the subsequent native improvements require this new version. See [the 1.3.39 release notes](docs/releases/1.3.39.md) for the exact scope.

## Earlier releases

The complete changelog through 1.3.38 is preserved byte-for-byte in
[the historical changelog](docs/releases/CHANGELOG-through-1.3.38.md), included in the npm package. No previous release entries have been discarded.
