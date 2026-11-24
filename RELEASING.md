# Releasing OpenCode Goals

**Manual releases only.** All GitHub Actions workflows were removed to stop runner consumption. Do not restore scheduled, push, pull-request or publishing workflows. An ordinary commit does not publish anything. The last verified npm version is 1.3.50. Changes to main after that publication remain unreleased.

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
Native V2 install also persists OpenCode's canonical plural `plugins` representation:
valid legacy `plugin` entries are normalized into that list, while malformed entries
and unrelated provider/model settings remain untouched.

## Manual release checklist

1. Choose a new version, update package.json and its numeric CHANGELOG release heading, and record the exact clean main commit. Never reuse an immutable published version for changed source.
2. Install dependencies in a local checkout. Run focused checks once, rather than an automatic platform matrix. `npm run release:check` is the existing complete local package gate; it is not automatically run by GitHub. The package's prepublishOnly hook still requires it.
3. Validate the target OpenCode host and native TUI locally. For OpenCode 2.4.1 use matching OpenTUI core/solid 0.9.4 and Solid 1.9.17. Run the packed consumer with `GOAL_OPENTUI_SMOKE_VERSION=0.9.4 npm run package:smoke` (PowerShell: `$env:GOAL_OPENTUI_SMOKE_VERSION='0.9.4'; npm run package:smoke`). Also run a real Bun renderer with the matching dependencies. Retain the older pinned host checks as needed; peer ranges alone do not prove runtime compatibility.
4. Check npm latest and the intended predecessor, and check the candidate tarball contents, exact package name/version/exports, installer, and independent Goal-only installation. Do not publish if any required check fails or has not been executed.
5. Only after an explicit release decision, an authorized maintainer can publish from the clean, verified checkout with npm's supported authentication and normal release checks. Do not bypass prepublishOnly, embed credentials, or silently re-enable an Actions trusted publisher. If manual npm authentication is unavailable, stop rather than weakening publication policy.

The old Actions gate command is deliberately retired and fails immediately instead of polling for deleted workflows. Its pure source-identity regression helpers remain usable offline. The unit test runner no longer expects workflow YAML files. No release is authorized by this document alone.

## Final verification

After publication the authoritative registry must expose the exact version,
matching gitHead, package exports, production dependencies, expected installer bin
and latest tag. A clean consumer runs the public installer with --version and
imports the published native server/shared RPC without TUI peers, then imports the TUI with the supported host peer set.

A merge, tag or successful upload alone is not publication proof.
Record the published version, source SHA, integrity and successful consumer check.
See docs/releases/1.3.50.md for published 1.3.50 scope and limits, including the unreproduced silent-stall/Windows Desktop reports.
