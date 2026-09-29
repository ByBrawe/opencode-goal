# Native OpenCode 2 Goal sidebar

The package ./tui entry now exposes native setup(context) and appends
an OpenTUI text component to sidebar.content. Its old tui(api) entry
remains lazy and isolated for explicitly supported V1 hosts.

The V2 panel never reads the CLI machine's Goal files. It calls the
connected server's opencode-goal-status/read RPC with the displayed
session's location, including workspaceID. The server checks the
session identity and its directory/workspace against its own instance
before formatting the read-only Goal and queue view. A missing RPC,
disconnected server, missing session location or mismatched response
is shown as unavailable, not as a fabricated empty Goal.

Status includes Goal state, proven requirements, objective preview,
cumulative turns/tokens and queued objectives. This is presentation,
not a new planner, proof source, lifecycle tool or continuation owner.
Corrupt/symlinked storage stays unavailable and is never repaired.

Requests are serialized and bounded to five seconds. Visible panels
refresh every two seconds; busy native events coalesce. Switching a
session or unloading cancels the old request, clears timers/listeners,
and fences late responses. Terminal control characters are stripped.
UI peers are optional for server-only users and resolved by the native
TUI host when rendering; importing ./tui alone does not load them.

Tests cover the published entry, read-only and cross-location RPC,
corrupt storage, unload during lookup, remote request routing, stale
responses, coalescing, timeouts and cleanup. A separate Bun/OpenTUI
render smoke asserts actual visible text and reactive session changes.
Full two-repository/current-head host validation and npm publication
remain separate gates; this document does not claim a release.

References:
- https://opencode.ai/v2/docs/build/plugins/cli/
- https://opencode.ai/v2/docs/build/plugins/rpc/
- https://opencode.ai/v2/docs/build/client
