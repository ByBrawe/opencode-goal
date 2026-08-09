# Changelog

All notable changes to **OpenCode Goals** are documented here.

## 1.1.0 — 2026-08-10

First compatible feature release after 1.0.0. Persisted schema-v1 and the stable V1 OpenCode plugin interface remain compatible.

### Goal control-plane and completion audit

- Added read-only `/goal audit` so the persisted requirement/evidence ledger and completion gate can be inspected without running verification or mutating Goal state.
- Added project-wide read-only Goal discovery with `/goal list` and ID-prefix detail inspection without adopting or mutating foreign-session Goals.
- Hardened autonomous continuation guidance to preserve the full user objective and authorization scope across ordinary shell/edit/test work, compaction, and multiple turns.
- Completion guidance now requires requirement-by-requirement positive proof, scope-matched verification, and treats narrow green tests, stale/indirect evidence, or assistant-authored recommendations as insufficient for broader completion claims.

### Competitive validation tooling

- Added a repo-only competitive benchmark CLI with disposable workspaces, isolated HOME/XDG state, shell-free argv execution, timeout process-tree cleanup, secret redaction, fixture/manifest SHA-256 metadata, and oracle-authoritative scoring.
- Added deterministic hidden-oracle fixtures for normal completion, false-complete resistance, and hard constraint/public-API preservation.
- Added `--preflight` to reject placeholder metadata, unpinned/moving plugin versions, missing provider environment, missing executables, and invalid baseline oracle state before spending model quota.
- Benchmark reports include weighted/category scoring plus detailed redacted JSON/Markdown failure evidence.

### Release and compatibility

- Stable package remains `@bybrawe/opencode-goal` and publishes through npm Trusted Publishing/OIDC.
- Normal OpenCode CLI/TUI/Desktop terminal and tool execution remains work-plane activity: it may change the worktree and produce progress/evidence, but it does not silently rewrite the persisted Goal contract or objective.

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
