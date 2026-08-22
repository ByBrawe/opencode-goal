# Goal infrastructure recovery

OpenCode Goal separates **project failure** from **infrastructure failure**.

A temporary provider/network/verifier outage must not turn a still-valid Goal into a permanent manual-resume dead end, and it must not create a second autonomous continuation while OpenCode still owns the original retry.

## What is recoverable

The recovery layer recognizes transient infrastructure signals such as:

- semantic verifier unavailable / verifier timeout;
- `fetch failed` / network connection lost;
- connection reset/refused and common transient socket/DNS errors (`ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, etc.);
- retryable HTTP/provider failures such as 429 and 5xx/service-unavailable responses;
- transient Goal-owned continuation prompt transport failures;
- transient restart-recovery prompt failures.

Authentication/configuration failures and ordinary project blockers are not automatically converted into recovery.

## Recovery state

A recoverable failure remains a Goal infrastructure state, not proof of completion and not fake workspace progress:

```text
status: active
infrastructureRecovery:
  kind: semantic_verifier | continuation_dispatch | provider_retry
  attempt: N
  nextRetryAt: ...
```

Semantic verification remains fail-closed. No semantic requirement becomes proven merely because the verifier was unavailable.

## Backoff

Automatic retries use bounded exponential backoff:

```text
15s -> 30s -> 60s -> 120s -> 240s -> 300s cap
```

The recovery state is persisted, so restarting OpenCode does not erase the cooldown or require a manual `/goal resume`.

## Single-owner rule

If OpenCode reports:

```text
session.status = retry
```

Goal does not inject another prompt. The host/provider still owns that turn.

If the status API itself cannot be read during an outage, recovery treats the state as unknown and waits; uncertainty is never interpreted as permission to dispatch.

If an explicit host `retry` remains stuck for two minutes, the recovery watchdog may abort only the active persisted Goal recovery turn and return it to the plugin's backoff path. It does not abort unrelated foreground/user work.

## Idle and compaction interaction

A normal `session.idle` arriving immediately after an infrastructure failure cannot bypass the recovery deadline. While a cooldown is pending, ordinary idle is suppressed.

At the deadline, Goal emits one marked synthetic idle through the normal Goal hook stack. Existing ownership, sequence, task-deferral, Plan restrictions, host-limit handling, and compaction continuation rules therefore remain authoritative.

The existing post-compaction coordinator remains the single continuation owner for compaction. Infrastructure recovery does not enable OpenCode's generic post-compaction synthetic `continue`.

## No-progress accounting

An infrastructure-only attempt is not an agent no-progress turn.

Recovery therefore consumes a one-shot stall-accounting exemption on the next wake-up. It does not fabricate a file/shell progress fingerprint, and it does not erase legitimate earlier stalled-turn history.

## Restart behavior

Generic active-Goal startup recovery excludes Goals that already have a future `infrastructureRecovery.nextRetryAt`. The infrastructure coordinator restores those timers instead. This prevents two restart mechanisms from waking the same Goal.

A transient failure of the restart-recovery prompt itself enters the same persisted backoff path.

## Legacy 1.3.25 migration

The startup scan narrowly recognizes old states that were dead-ended solely by infrastructure, including:

- `paused` with `Independent semantic verification unavailable: ...`;
- transient `Continuation dispatch failed: ...`;
- transient `Restart recovery prompt failed: ...`;
- `blocked` completion-audit records whose reason explicitly identifies verifier/provider/timeout infrastructure failure.

Ordinary user pauses and real project blockers are not migrated.

This specifically covers older stored Goals where the Todo/work was already complete but the semantic verifier timed out and the only remaining action was a manual `/goal resume`.

## Operational diagnosis

During recovery, the persisted Goal remains inspectable with `/goal status`; `stopReason` identifies the infrastructure recovery kind and the underlying reason. Project files and Goal evidence remain untouched while waiting.

If a permanent provider/authentication configuration error is present, fix that configuration and then use the normal Goal controls. Automatic infrastructure recovery is intentionally limited to transient-looking failures.
