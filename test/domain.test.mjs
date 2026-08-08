import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import { auditCompletion, completeGoal } from "../dist/verification/audit.js"
import { proveRequirementsFromEvidence, recordCommandEvidence } from "../dist/verification/evidence.js"
import { addProgressNote, closeObservedTurn, markHostActivity } from "../dist/runtime/progress.js"
import { reportBlocker } from "../dist/runtime/blocker.js"
import { accountAssistantUsage } from "../dist/runtime/accounting.js"

test("agent completion claim cannot prove an unverified goal", () => {
  const goal = createGoal({ sessionID: "s1", objective: "ship feature" })
  const result = completeGoal(goal, "done")
  assert.equal(result.audit.ok, false)
  assert.equal(result.goal.status, "active")
})

test("trusted current evidence can prove its bound command requirement", () => {
  let goal = createGoal({ sessionID: "s1", objective: "tests green", checks: ["npm test"] })
  const req = goal.requirements.find((item) => item.verification === "command")
  assert.ok(req)
  goal = recordCommandEvidence(goal, { command: "npm test", exitCode: 0, output: "pass", requirementIDs: [req.id] })
  goal = proveRequirementsFromEvidence(goal, goal.evidence.at(-1).id)
  assert.equal(goal.requirements.find((item) => item.id === req.id).status, "proven")
})

test("unrelated host evidence cannot prove a semantic acceptance criterion", () => {
  let goal = createGoal({ sessionID: "s1", objective: "secure release", acceptance: ["security review is complete"] })
  const req = goal.requirements[0]
  goal = recordCommandEvidence(goal, { command: "echo ok", exitCode: 0, output: "ok", requirementIDs: [req.id] })
  assert.throws(() => proveRequirementsFromEvidence(goal, goal.evidence.at(-1).id), /verification contract/)
})

test("stale evidence cannot prove an edited goal", () => {
  let goal = createGoal({ sessionID: "s1", objective: "old", checks: ["npm test"] })
  const req = goal.requirements[0]
  goal = recordCommandEvidence(goal, { command: "npm test", exitCode: 0, output: "ok", requirementIDs: [req.id] })
  const evidenceID = goal.evidence.at(-1).id
  goal = editGoal(goal, { objective: "new", checks: ["npm test"] })
  assert.throws(() => proveRequirementsFromEvidence(goal, evidenceID), /stale evidence/)
})

test("one passing check cannot bypass another semantic acceptance requirement", () => {
  let goal = createGoal({ sessionID: "s1", objective: "ship", acceptance: ["docs updated"], checks: ["npm test"] })
  const check = goal.requirements.find((item) => item.verification === "command")
  goal = recordCommandEvidence(goal, { command: "npm test", exitCode: 0, output: "ok", requirementIDs: [check.id] })
  goal = proveRequirementsFromEvidence(goal, goal.evidence.at(-1).id)
  const audit = auditCompletion(goal)
  assert.equal(audit.ok, false)
  assert.match(audit.reasons.join("\n"), /docs updated/)
})

test("a newer passing host verification supersedes an older failure", () => {
  let goal = createGoal({ sessionID: "s1", objective: "tests green", checks: ["npm test"] })
  const req = goal.requirements[0]
  goal = recordCommandEvidence(goal, { command: "npm test", exitCode: 1, output: "fail", requirementIDs: [req.id], now: 10 })
  goal = recordCommandEvidence(goal, { command: "npm test", exitCode: 0, output: "pass", requirementIDs: [req.id], now: 20 })
  goal = proveRequirementsFromEvidence(goal, goal.evidence.at(-1).id, 20)
  assert.equal(auditCompletion(goal).ok, true)
})

test("progress notes do not count as host-observed progress", () => {
  let goal = createGoal({ sessionID: "s1", objective: "work" })
  for (let i = 0; i < 3; i += 1) {
    goal = addProgressNote(goal, { summary: `claimed progress ${i}`, next: "continue" })
    goal = closeObservedTurn(goal)
  }
  assert.equal(goal.status, "paused")
  assert.equal(goal.stalledTurns, 3)
})

test("blocker requires three distinct turns", () => {
  let goal = createGoal({ sessionID: "s1", objective: "deploy" })
  goal = reportBlocker(goal, { turnID: "t1", reason: "missing token", key: "missing-prod-token" })
  assert.equal(goal.status, "active")
  goal = reportBlocker(goal, { turnID: "t1", reason: "missing token", key: "missing-prod-token" })
  assert.equal(goal.blockerAudit.consecutiveTurns, 1)
  goal = reportBlocker(goal, { turnID: "t2", reason: "missing token", key: "missing-prod-token" })
  assert.equal(goal.status, "active")
  goal = reportBlocker(goal, { turnID: "t3", reason: "missing token", key: "missing-prod-token" })
  assert.equal(goal.status, "blocked")
})

test("usage is deduplicated and budget limited instead of completed", () => {
  let goal = createGoal({ sessionID: "s1", objective: "work", budget: { maxTurns: 2 } })
  goal = accountAssistantUsage(goal, { messageID: "m1", inputTokens: 10, outputTokens: 5 })
  goal = accountAssistantUsage(goal, { messageID: "m1", inputTokens: 10, outputTokens: 5 })
  assert.equal(goal.usage.turns, 1)
  goal = accountAssistantUsage(goal, { messageID: "m2", inputTokens: 10, outputTokens: 5 })
  assert.equal(goal.status, "budget_limited")
  assert.equal(goal.usage.turns, 2)
})

test("host-observed mutating activity resets stalled-turn accounting", () => {
  let goal = createGoal({ sessionID: "s1", objective: "work" })
  goal = closeObservedTurn(goal)
  assert.equal(goal.stalledTurns, 1)
  goal = markHostActivity(goal, { source: "edit", summary: "changed source" })
  goal = closeObservedTurn(goal)
  assert.equal(goal.stalledTurns, 0)
  assert.equal(goal.status, "active")
})
