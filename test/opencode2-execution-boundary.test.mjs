import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { markHostProgress } from "../dist/runtime/progress.js"
import {
  openCode2ExecutionSessionID,
  openCode2ExecutionTerminal,
  settleGoalForOpenCode2ExecutionEvent,
} from "../dist/opencode2/execution-boundary.js"

function succeeded(sessionID = "v2-session") {
  return { type: "session.execution.succeeded", properties: { sessionID } }
}

test("OpenCode 2 execution boundary recognizes exact terminal events and session shapes", () => {
  assert.equal(openCode2ExecutionTerminal(succeeded()), "succeeded")
  assert.equal(openCode2ExecutionTerminal({ type: "session.execution.failed" }), "failed")
  assert.equal(openCode2ExecutionTerminal({ type: "session.execution.interrupted" }), "interrupted")
  assert.equal(openCode2ExecutionTerminal({ type: "session.idle" }), undefined)

  assert.equal(openCode2ExecutionSessionID({ type: "session.execution.succeeded", properties: { sessionID: "properties-id" } }), "properties-id")
  assert.equal(openCode2ExecutionSessionID({ type: "session.execution.succeeded", data: { sessionID: "data-id" } }), "data-id")
  assert.equal(openCode2ExecutionSessionID({ type: "session.execution.succeeded", sessionID: "root-id" }), "root-id")
})

test("only successful OpenCode 2 executions close Goal turns", () => {
  const initial = createGoal({ sessionID: "v2-session", objective: "ship exact V2 parity", now: 100 })

  const failed = settleGoalForOpenCode2ExecutionEvent(initial, { type: "session.execution.failed", properties: { sessionID: "v2-session" } }, { now: 200 })
  assert.equal(failed.closed, false)
  assert.equal(failed.goal, initial)

  const interrupted = settleGoalForOpenCode2ExecutionEvent(initial, { type: "session.execution.interrupted", properties: { sessionID: "v2-session" } }, { now: 300 })
  assert.equal(interrupted.closed, false)
  assert.equal(interrupted.goal, initial)

  const first = settleGoalForOpenCode2ExecutionEvent(initial, succeeded(), { now: 400 })
  assert.equal(first.closed, true)
  assert.equal(first.goal.stalledTurns, 1)
  assert.equal(first.goal.status, "active")

  const second = settleGoalForOpenCode2ExecutionEvent(first.goal, succeeded(), { now: 500 })
  assert.equal(second.goal.stalledTurns, 2)
  assert.equal(second.goal.status, "active")

  const third = settleGoalForOpenCode2ExecutionEvent(second.goal, succeeded(), { now: 600 })
  assert.equal(third.goal.stalledTurns, 3)
  assert.equal(third.goal.status, "paused")
  assert.match(third.goal.stopReason ?? "", /3 continuation turns without host-observed progress/)
})

test("host progress resets the OpenCode 2 no-progress streak at a successful execution boundary", () => {
  const initial = createGoal({ sessionID: "v2-session", objective: "ship V2 progress parity", now: 100 })
  const first = settleGoalForOpenCode2ExecutionEvent(initial, succeeded(), { now: 200 }).goal
  assert.equal(first.stalledTurns, 1)

  const progressed = markHostProgress(first, {
    fingerprint: "file:README.md:abc123",
    source: "test",
    summary: "README changed",
    now: 250,
  })
  const second = settleGoalForOpenCode2ExecutionEvent(progressed, succeeded(), { now: 300 }).goal
  assert.equal(second.stalledTurns, 0)
  assert.equal(second.observedProgressRevision, progressed.progressRevision)
  assert.equal(second.status, "active")
})
