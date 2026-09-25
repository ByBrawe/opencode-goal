import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import {
  classifyOpenCode2ExecutionFailure,
  clearOpenCode2HostLimitSession,
  createOpenCode2HostLimitRuntime,
  markOpenCode2OwnedExecutionSuccess,
  normalizeOpenCode2ProviderFailure,
  observeOpenCode2CompactionReason,
  observeOpenCode2NativeCompaction,
  repeatedOpenCode2CompactionReason,
} from "../dist/opencode2/host-limits.js"

test("V2 exact provider failure envelope normalizes into shared V1 limit policy", () => {
  const normalized = normalizeOpenCode2ProviderFailure({
    type: "provider.invalid-request",
    message: "Prompt exceeds max length for exact host-limit proof",
    status: 400,
    providerID: "canary",
  })
  assert.deepEqual(normalized, {
    name: "APIError",
    data: {
      providerID: "canary",
      message: "Prompt exceeds max length for exact host-limit proof",
      statusCode: 400,
      isRetryable: false,
    },
  })
})

test("V2 unrecovered prompt overflow pauses the matching active Goal fail-closed", () => {
  const goal = createGoal({ sessionID: "overflow", objective: "stay durable", now: 100 })
  const result = classifyOpenCode2ExecutionFailure(goal, {
    type: "provider.invalid-request",
    message: "Prompt exceeds max length for exact host-limit proof",
    status: 400,
  }, 200)

  assert.equal(result.kind, "overflow")
  assert.equal(result.goal.status, "paused")
  assert.match(result.goal.stopReason ?? "", /prompt\/context limit/i)
  assert.match(result.goal.stopReason ?? "", /native compaction did not recover/i)
  assert.equal(result.goal.updatedAt, 200)
})

test("V2 retryable provider failure enters shared bounded infrastructure recovery", () => {
  const goal = createGoal({ sessionID: "retry", objective: "retry safely", now: 100 })
  const result = classifyOpenCode2ExecutionFailure(goal, {
    type: "provider.unavailable",
    message: "temporary provider overload",
    status: 503,
  }, 1_000)

  assert.equal(result.kind, "transient")
  assert.equal(result.goal.status, "active")
  assert.equal(result.goal.infrastructureRecovery?.kind, "provider_retry")
  assert.equal(result.goal.infrastructureRecovery?.attempt, 1)
  assert.equal(result.goal.infrastructureRecovery?.startedAt, 1_000)
  assert.ok((result.goal.infrastructureRecovery?.nextRetryAt ?? 0) > 1_000)
  assert.equal(result.goal.skipNextStallCheck, true)
})

test("V2 fatal provider auth failure pauses without retry metadata", () => {
  const goal = createGoal({ sessionID: "auth", objective: "do not spin", now: 100 })
  const result = classifyOpenCode2ExecutionFailure(goal, {
    type: "provider.auth",
    message: "Unauthorized API credential",
    status: 401,
    providerID: "canary",
  }, 500)

  assert.equal(result.kind, "fatal")
  assert.equal(result.goal.status, "paused")
  assert.match(result.goal.stopReason ?? "", /authentication failed/i)
  assert.equal(result.goal.infrastructureRecovery, undefined)
})

test("V2 host-limit classifier ignores inactive Goals", () => {
  const active = createGoal({ sessionID: "inactive", objective: "ignore stale failure", now: 100 })
  const goal = { ...active, status: "paused" }
  const result = classifyOpenCode2ExecutionFailure(goal, {
    type: "provider.invalid-request",
    message: "Prompt exceeds max length",
    status: 400,
  }, 200)

  assert.equal(result.kind, "ignore")
  assert.equal(result.goal, goal)
})

test("V2 native auto-compaction loop guard requires a successful owned execution between repeats", () => {
  const runtime = createOpenCode2HostLimitRuntime()
  const goal = createGoal({ sessionID: "compact-loop", objective: "avoid compaction spin", now: 100 })

  assert.deepEqual(observeOpenCode2NativeCompaction(runtime, goal), {
    repeatedWithoutOwnedSuccess: false,
  })
  assert.deepEqual(observeOpenCode2NativeCompaction(runtime, goal), {
    repeatedWithoutOwnedSuccess: true,
  })

  markOpenCode2OwnedExecutionSuccess(runtime, goal.sessionID)
  assert.deepEqual(observeOpenCode2NativeCompaction(runtime, goal), {
    repeatedWithoutOwnedSuccess: false,
  })

  assert.match(repeatedOpenCode2CompactionReason(), /same Goal revision again/i)
  clearOpenCode2HostLimitSession(runtime, goal.sessionID)
  assert.deepEqual(observeOpenCode2NativeCompaction(runtime, goal), {
    repeatedWithoutOwnedSuccess: false,
  })
})

test("V2 compaction reason is scoped and consumed once", async () => {
  const runtime = createOpenCode2HostLimitRuntime()
  observeOpenCode2CompactionReason(runtime, "s1", {
    type: "session.compaction.started",
    data: { sessionID: "s1", reason: "auto" },
  })
  assert.equal(runtime.compactionReasonBySession.get("s1"), "auto")

  const { consumeOpenCode2CompactionReason } = await import("../dist/opencode2/host-limits.js")
  assert.equal(consumeOpenCode2CompactionReason(runtime, "s1"), "auto")
  assert.equal(consumeOpenCode2CompactionReason(runtime, "s1"), undefined)
})
