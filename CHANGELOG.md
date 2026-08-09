# Changelog

All notable changes to **OpenCode Goals** are documented here.

## 1.0.0 — 2026-08-09

First stable release.

### Goal contracts and completion integrity

- Persistent Goal Contract with objective, repeatable success criteria, hard constraints/non-goals, host checks, file contracts, budgets, and revision ownership.
- Independent read-only semantic verifier; the executor cannot complete its own Goal by self-report.
- Host-corroborated command/file evidence with stale-evidence rejection and exact revision binding.
- Constraints remain mandatory completion requirements even when narrower mechanical checks pass.

### Autonomous execution safety

- Durable multi-turn continuation with no-progress and blocker guards.
- Plan/restricted-agent execution boundary: planning can define a Goal but cannot silently escape into implementation.
- Foreground/background delegated-task coordination so the parent Goal does not race active child work.
- Provider quota/fatal-error classification plus local turn/token/time/cost budgets.
- User intervention, pause/edit, and verification races fail closed.

### Persistence and recovery

- Project-local atomic Goal storage with process leases and optimistic generation/CAS stale-write refusal.
- Symlink/junction escape protection and fail-closed handling for corrupt or unsupported storage.
- Real process-restart recovery with interrupted-turn accounting preserved.
- Per-session archive/history, explicit live-safe prune, read-only doctor, and safe paused restore.

### OpenCode integration

- `/goal`, `/goal status`, `/goal contract`, `/goal doctor`, lifecycle controls, history, restore, and budget commands.
- Server/session-layer authoritative state usable across normal OpenCode CLI/TUI/web session surfaces.
- Best-effort TUI lifecycle/delegation feedback that never participates in correctness.
- Windows and Ubuntu real-host/restart canaries plus minimum/latest OpenCode plugin compatibility checks.

### Release and supply-chain policy

- npm package: `@bybrawe/opencode-goal`.
- Stable channel publishes to npm `latest` through GitHub Actions trusted publishing/OIDC.
- The publish workflow has `contents: read` and narrowly scoped `id-token: write`; checkout credentials are not persisted.
- Repository workflows do not automatically push commits or merge pull requests.
- Post-1.0 breaking public-interface changes require a new major version.

## 0.1.0-beta.1 / 0.1.0-beta.2

Public prerelease line used to harden verification, persistence, restart recovery, storage integrity/concurrency, Goal Contracts, Plan safety, delegated-task coordination, and release gates before 1.0.0.
