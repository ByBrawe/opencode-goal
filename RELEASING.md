# Releasing OpenCode Goals

Release readiness and publication are separate. Work remains on `main`; no repair
or release branch is needed. Publish only an immutable commit which passes all
required gates. A green older commit is not evidence for the release candidate.

## Required release gates

The exact main push must pass all of these before npm publication:

- CI
- Actions Security Gate
- Real Host Progress
- Real Restart Recovery
- Release Readiness
- Experimental OpenCode 2 Host
- Current OpenCode 2 Stable Host
- OpenCode 2 Todo Materialization Diff
- OpenCode 2 Unit Handoff
- Native Goal Sidebar

`scripts/native-release-gate.mjs` enforces this list. Missing, pending, skipped,
failed, cancelled, wrong-commit, PR-only or fork runs never count as success. The
publisher waits at most fifteen minutes, then refuses publication. Both previously
PR-only current-stable and Todo-differential workflows now run on main as well.

CI retains V1 minimum/current compatibility and native lifecycle/semantic/steering
coverage. Release Readiness checks Ubuntu/Windows with Node 20/24, unit tests,
adversarial evaluation and a production-only installed tarball. Native Goal Sidebar
checks actual OpenTUI rendering on both operating systems and two-location RPC on
OpenCode 2.0.18. Unit Handoff tests 2.0.16 and 2.0.18 independently.

## Package contract

The public package root is the OpenCode 2 `Plugin.define({ id, setup })` entrypoint.
The same dual definition is exposed through `./server`; programmatic named APIs are
isolated at `./api`, while `./v1` is the explicit lazy OpenCode 1 implementation.
The `./tui`, `./v2`, `./rpc`, `./api` and `./v1` exports must remain packageable and
independently importable as appropriate.

Runtime imports must be declared as production dependencies. Optional OpenTUI peers must match the supported host. Server and native-only
entrypoints are verified from a production cache with peers omitted; the TUI
entrypoint is verified separately with the supported OpenTUI/Solid host peer set.
The installer bin must remain `bin/opencode-goal.js` and report package.json's exact
version. Multi-config install/update must pin that version everywhere, preserve
user-owned command files and options, and uninstall must preserve project Goal state.

Local gates:

```sh
npm install
npm run release:check
npm run test:tui-native
```

## Trusted publication

The current authorized release is 1.3.42, following npm latest 1.3.41. The publisher
runs on an explicit workflow dispatch or a main update to its workflow/package
manifest. Other versions are skipped until the release guard is deliberately changed.

The existing `publish-npm.yml` is the only OIDC publisher. It retains read-only
contents, no persisted checkout credentials, no long-lived npm token and no git
push. Actions read permission is used only to verify exact-commit checks. The
immutable triggering SHA is checked out; publication is serialized and never
cancelled by a newer publisher run. npm >=11.5.1 is required.

An existing immutable npm version must have the same gitHead as the release source.
A different gitHead is an error, not a successful no-op. Use a new version for new
source. For an unpublished version the registry's latest must equal the declared
predecessor, preventing accidental downgrades or out-of-order publication.

After exact-main gates, the publisher exercises the pinned Loop source with Goal
on real OpenCode 2.0.18, plus read-only native status. npm publish also runs the
existing prepublishOnly release:check; no product gate is removed.

## Final verification

After publication the authoritative registry must expose the exact version,
matching gitHead, package exports, production dependencies, expected installer bin
and latest tag. A clean consumer runs the public installer with --version and
imports the published native server/shared RPC without TUI peers, then imports the TUI with the supported host peer set.

A started workflow, merge, tag or successful upload alone is not publication proof.
Record the published version, source SHA, integrity and successful consumer check.
See docs/releases/1.3.42.md for this release's product scope and limitations.
