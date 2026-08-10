# Ordered Goal sequences and TUI sidebar

OpenCode Goals keeps the safety invariant of **one live Goal per session**. Multiple Goals are represented as one authoritative live Goal plus an ordered queue of inert future Goal Contracts. The queue adds workflow breadth without introducing simultaneous writers that could race verifier ownership, evidence revisions, or GoalStore CAS protection.

## Commands

Queue another Goal Contract without replacing the current Goal:

```text
/goal add update docs --success "docs match the shipped behavior" --check "npm test"
```

Inspect or reorder the pending sequence:

```text
/goal queue
/goal queue move <goal-id-prefix> <1-based-position>
/goal queue remove <goal-id-prefix>
/goal queue clear
```

Activate the next pending Goal explicitly:

```text
/goal next
```

`/goal next` refuses while an unfinished live Goal exists. A queue with no live Goal stays inert until this explicit command.

## Automatic ordered progression

When the live Goal is actually persisted `completed`, a `session.idle` boundary may promote exactly one queued Goal if the completed Goal has a known non-Plan execution binding. Promotion never happens inside the completing assistant turn, so an old turn cannot write progress or completion evidence into the next Goal.

The promoted Goal receives:

- the queued objective, success criteria, constraints, checks, file contracts, and local budget;
- a reserved stable Goal ID for crash recovery;
- revision `1` with fresh evidence, usage, progress, and blocker state;
- the previous completed Goal's execution binding only, so the same selected Build/model context can continue.

No completion evidence, semantic proof, usage ledger, or progress fingerprints are inherited.

Plan or unknown execution contexts do not auto-promote. Switch to an execution-capable agent and use explicit Goal control when continuation is authorized.

## Persistence and concurrency

Pending sequences are stored project-locally under:

```text
.opencode/goal-sequences/
```

Queue mutation and promotion reuse the same per-session `.opencode/goal-locks/` process lease as live Goal persistence. Cross-process promoters therefore serialize with live Goal writers.

Promotion uses an `activating` marker on the queue head. If the process dies after writing the new live Goal but before removing the queue head, the next process recognizes the same reserved Goal ID and finishes the queue transition instead of creating a duplicate or skipping another Goal.

Queue corruption/path-integrity failures are fail-closed. `/goal doctor` reports queue storage status in addition to live/archive diagnostics.

## TUI sidebar

Current OpenCode TUI versions support package TUI plugins and the `sidebar_content` slot. The package exposes a separate `@bybrawe/opencode-goal/tui` entrypoint so presentation stays isolated from the server Goal runtime.

The sidebar is deliberately read-only. It shows the current Goal status, proven/required count, objective, turn/token budget, and the first pending Goals in sequence. It reads the same project-local state with path/symlink checks and displays a visible storage-unavailable warning instead of following unsafe paths.

Sidebar rendering never proves completion, changes a Goal, advances the queue, or participates in verifier decisions. A missing or unsupported TUI leaves CLI/headless/Desktop Goal correctness unchanged.
