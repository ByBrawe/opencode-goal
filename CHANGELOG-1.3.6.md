# 1.3.6 — 2026-08-11

Multi-config installer hotfix.

- Normalizes the exact OpenCode Goals package pin across every existing supported global OpenCode config filename instead of updating only the first match.
- Stages and validates all config rewrites before mutating real config files, so an invalid secondary config cannot leave a partial install.
- Preserves the existing JSON/JSONC comment-aware rewrite logic by delegating each staged file through the battle-tested installer implementation.
- Keeps user-owned `commands/goal.md` protection, managed `/goal` discovery, duplicate local-plugin cleanup, and uninstall behavior intact.
- Adds regression coverage for two simultaneous global config files, idempotence, and fail-closed secondary-config errors.

This specifically targets installations where `/goal` is visible but the managed command bridge reaches the model because a later-loaded global config shadows the plugin registration.
