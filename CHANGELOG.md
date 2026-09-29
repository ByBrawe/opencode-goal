# Changelog

All notable changes to **OpenCode Goals** are documented here.

## 1.3.39 - 2026-09-29

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
