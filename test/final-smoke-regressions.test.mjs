import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { reportBlocker } from "../dist/runtime/blocker.js"
import { closeObservedTurn } from "../dist/runtime/progress.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "../dist/verification/evidence.js"

test("file evidence accepts the 1-based requirement number shown by Goal status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-evidence-number-"))
  try {
    await writeFile(path.join(root, "test.txt"), "OK", "utf8")
    let goal = createGoal({
      sessionID: "s1",
      objective: "create test.txt",
      files: [{ file: "test.txt", contains: "OK" }],
    })
    const fileRequirement = goal.requirements[1]
    assert.equal(fileRequirement.verification, "file")

    const checked = await recordFileEvidence(goal, { root, requirementID: "2" })
    assert.equal(checked.evidence.passed, true)
    assert.deepEqual(checked.evidence.requirementIDs, [fileRequirement.id])

    goal = proveRequirementsFromEvidence(checked.goal, checked.evidence.id)
    assert.equal(goal.requirements[1].status, "proven")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a repeated blocker gets its third turn before the generic stall guard can preempt it", () => {
  let goal = createGoal({ sessionID: "s1", objective: "impossible verification" })

  goal = reportBlocker(goal, { turnID: "t1", reason: "check always fails", key: "same-check" })
  goal = closeObservedTurn(goal)
  goal = closeObservedTurn(goal)
  assert.equal(goal.status, "active")
  assert.equal(goal.stalledTurns, 2)

  goal = reportBlocker(goal, { turnID: "t2", reason: "check still fails", key: "same-check" })
  assert.equal(goal.blockerAudit.consecutiveTurns, 2)
  assert.equal(goal.stalledTurns, 0, "the second distinct report should hand off to the blocker circuit breaker")

  goal = closeObservedTurn(goal)
  assert.equal(goal.status, "active")
  goal = reportBlocker(goal, { turnID: "t3", reason: "check still fails", key: "same-check" })
  assert.equal(goal.status, "blocked")
  assert.equal(goal.blockerAudit.consecutiveTurns, 3)
})

test("changing blocker keys cannot reset generic stall accounting", () => {
  let goal = createGoal({ sessionID: "s1", objective: "work" })
  goal = closeObservedTurn(goal)
  goal = closeObservedTurn(goal)
  assert.equal(goal.stalledTurns, 2)

  goal = reportBlocker(goal, { turnID: "t1", reason: "first excuse", key: "first" })
  assert.equal(goal.stalledTurns, 2)
  goal = reportBlocker(goal, { turnID: "t2", reason: "different excuse", key: "second" })
  assert.equal(goal.stalledTurns, 2)

  goal = closeObservedTurn(goal)
  assert.equal(goal.status, "paused")
  assert.equal(goal.stalledTurns, 3)
})
