import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { auditCompletion } from "../dist/verification/audit.js"
import {
  proveRequirementsFromEvidence,
  recordAgentNote,
  recordCommandEvidence,
} from "../dist/verification/evidence.js"
import { applySemanticVerifierResults } from "../dist/verification/semantic.js"

test("referenced trusted proof survives more than 500 unrelated evidence records", () => {
  let goal = createGoal({ sessionID: "retention-proof", objective: "tests stay green", checks: ["npm test"] })
  const check = goal.requirements.find((item) => item.verification === "command")
  assert.ok(check)

  goal = recordCommandEvidence(goal, {
    command: "npm test",
    exitCode: 0,
    output: "pass",
    requirementIDs: [check.id],
    now: 1,
  })
  const proofID = goal.evidence.at(-1).id
  goal = proveRequirementsFromEvidence(goal, proofID, 2)

  for (let index = 0; index < 600; index += 1) {
    goal = recordAgentNote(goal, { summary: `unrelated note ${index}`, now: 10 + index })
  }

  assert.equal(goal.evidence.length, 500)
  assert.ok(goal.evidence.some((item) => item.id === proofID), "current requirement proof must stay retained")
  const audit = auditCompletion(goal)
  assert.equal(audit.missingRequirementIDs.includes(check.id), false, "retention must not make the proven check lose trusted evidence")
})

test("latest failing verification survives retention even when the requirement still points at an older passing proof", () => {
  let goal = createGoal({ sessionID: "retention-failure", objective: "tests stay green", checks: ["npm test"] })
  const check = goal.requirements.find((item) => item.verification === "command")
  assert.ok(check)

  goal = recordCommandEvidence(goal, {
    command: "npm test",
    exitCode: 0,
    output: "pass",
    requirementIDs: [check.id],
    now: 1,
  })
  const passingID = goal.evidence.at(-1).id
  goal = proveRequirementsFromEvidence(goal, passingID, 2)
  goal = recordCommandEvidence(goal, {
    command: "npm test",
    exitCode: 1,
    output: "fail",
    requirementIDs: [check.id],
    now: 3,
  })
  const failingID = goal.evidence.at(-1).id

  for (let index = 0; index < 600; index += 1) {
    goal = recordAgentNote(goal, { summary: `later note ${index}`, now: 10 + index })
  }

  assert.equal(goal.evidence.length, 500)
  assert.ok(goal.evidence.some((item) => item.id === passingID), "the proven requirement anchor must stay retained")
  assert.ok(goal.evidence.some((item) => item.id === failingID), "the latest failing verification state must stay retained")
  const audit = auditCompletion(goal)
  assert.equal(audit.ok, false)
  assert.match(audit.reasons.join("\n"), /current verification result\(s\) are failing/)
})

test("re-proving a host-verifiable requirement keeps only the current proof pointer", () => {
  let goal = createGoal({ sessionID: "retention-pointer", objective: "tests stay green", checks: ["npm test"] })
  const check = goal.requirements.find((item) => item.verification === "command")
  assert.ok(check)

  goal = recordCommandEvidence(goal, {
    command: "npm test",
    exitCode: 0,
    output: "first pass",
    requirementIDs: [check.id],
    now: 1,
  })
  const firstID = goal.evidence.at(-1).id
  goal = proveRequirementsFromEvidence(goal, firstID, 2)

  goal = recordCommandEvidence(goal, {
    command: "npm test",
    exitCode: 0,
    output: "second pass",
    requirementIDs: [check.id],
    now: 3,
  })
  const secondID = goal.evidence.at(-1).id
  goal = proveRequirementsFromEvidence(goal, secondID, 4)

  const current = goal.requirements.find((item) => item.id === check.id)
  assert.deepEqual(current.evidenceIDs, [secondID])

  for (let index = 0; index < 600; index += 1) {
    goal = recordAgentNote(goal, { summary: `later note ${index}`, now: 10 + index })
  }

  assert.equal(goal.evidence.length, 500)
  assert.equal(goal.evidence.some((item) => item.id === firstID), false, "superseded proof should become pruneable")
  assert.ok(goal.evidence.some((item) => item.id === secondID), "current proof pointer must remain retained")
})

test("semantic verifier proof pointer stays current and completion remains auditable after retention", () => {
  let goal = createGoal({ sessionID: "retention-semantic", objective: "ship the verified semantic change" })
  const requirement = goal.requirements[0]

  goal = applySemanticVerifierResults(goal, [{
    requirementID: requirement.id,
    verdict: "proven",
    reason: "first verifier proof",
    evidence: [{ path: "README.md", quote: "first proof" }],
    hostEvidenceIDs: [],
  }], 1)
  const firstID = goal.requirements[0].evidenceIDs[0]

  goal = applySemanticVerifierResults(goal, [{
    requirementID: requirement.id,
    verdict: "proven",
    reason: "fresh verifier proof",
    evidence: [{ path: "README.md", quote: "fresh proof" }],
    hostEvidenceIDs: [],
  }], 2)
  const secondID = goal.requirements[0].evidenceIDs[0]
  assert.notEqual(secondID, firstID)
  assert.deepEqual(goal.requirements[0].evidenceIDs, [secondID])

  for (let index = 0; index < 600; index += 1) {
    goal = recordAgentNote(goal, { summary: `later note ${index}`, now: 10 + index })
  }

  assert.equal(goal.evidence.length, 500)
  assert.equal(goal.evidence.some((item) => item.id === firstID), false)
  assert.ok(goal.evidence.some((item) => item.id === secondID))
  assert.equal(auditCompletion(goal).ok, true)
})
