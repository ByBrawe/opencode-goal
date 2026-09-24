import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { prepareOpenCode2Continuation } from "../dist/opencode2/continuation-boundary.js"

function succeeded(sessionID = "v2-session") {
  return { type: "session.execution.succeeded", data: { sessionID } }
}

test("successful V2 execution prepares the shared Goal continuation while the Goal remains active", () => {
  const goal = createGoal({ sessionID: "v2-session", objective: "ship V2 continuation parity", now: 100 })
  const prepared = prepareOpenCode2Continuation(goal, succeeded(), { now: 200 })

  assert.equal(prepared.closed, true)
  assert.equal(prepared.shouldContinue, true)
  assert.equal(prepared.goal.status, "active")
  assert.equal(prepared.goal.stalledTurns, 1)
  assert.match(prepared.prompt ?? "", /Continue working toward the active OpenCode goal/)
  assert.match(prepared.prompt ?? "", /ship V2 continuation parity/)
})

test("V2 continuation stops exactly when no-progress closing pauses the Goal", () => {
  let goal = createGoal({ sessionID: "v2-session", objective: "bounded V2 continuation", now: 100 })
  goal = prepareOpenCode2Continuation(goal, succeeded(), { now: 200 }).goal
  goal = prepareOpenCode2Continuation(goal, succeeded(), { now: 300 }).goal

  const third = prepareOpenCode2Continuation(goal, succeeded(), { now: 400 })
  assert.equal(third.closed, true)
  assert.equal(third.shouldContinue, false)
  assert.equal(third.prompt, undefined)
  assert.equal(third.goal.status, "paused")
  assert.equal(third.goal.stalledTurns, 3)
})

test("failed and interrupted V2 executions never prepare autonomous continuation", () => {
  const goal = createGoal({ sessionID: "v2-session", objective: "do not recover from the wrong terminal", now: 100 })

  for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
    const prepared = prepareOpenCode2Continuation(goal, { type, data: { sessionID: "v2-session" } }, { now: 200 })
    assert.equal(prepared.closed, false)
    assert.equal(prepared.shouldContinue, false)
    assert.equal(prepared.prompt, undefined)
    assert.equal(prepared.goal, goal)
  }
})
