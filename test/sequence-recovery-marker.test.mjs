import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { closeObservedTurn } from "../dist/runtime/progress.js"

test("sequence activation marker cannot suppress accounting after a real recovered turn", () => {
  const goal = createGoal({ sessionID: "sequence-recovered-turn", objective: "continue after restart" })
  goal.pendingContinuation = true
  goal.usage.turns = 1
  const closed = closeObservedTurn(goal, { now: 20 })
  assert.equal(closed.pendingContinuation, undefined)
  assert.equal(closed.stalledTurns, 1)
})
