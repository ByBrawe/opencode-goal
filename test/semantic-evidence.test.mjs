import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { applySemanticVerifierResults } from "../dist/verification/semantic.js"

test("semantic verifier file quotes are classified as file evidence", () => {
  const goal = createGoal({ sessionID: "s1", objective: "ship verified docs" })
  const requirement = goal.requirements.find((item) => item.verification === "semantic")
  assert.ok(requirement)

  const next = applySemanticVerifierResults(goal, [{
    requirementID: requirement.id,
    verdict: "proven",
    reason: "Current README directly proves the objective.",
    evidence: [{ path: "README.md", quote: "Verified Goal Mode", sha256: "abc123" }],
    hostEvidenceIDs: [],
  }])

  const evidence = next.evidence.at(-1)
  assert.equal(evidence.trust, "verifier")
  assert.equal(evidence.kind, "file")
  assert.equal(evidence.passed, true)
})

test("semantic verifier host-only references remain runtime evidence", () => {
  const goal = createGoal({ sessionID: "s1", objective: "tests establish requested behavior" })
  const requirement = goal.requirements.find((item) => item.verification === "semantic")
  assert.ok(requirement)

  const next = applySemanticVerifierResults(goal, [{
    requirementID: requirement.id,
    verdict: "proven",
    reason: "A current host verification establishes the requirement.",
    evidence: [],
    hostEvidenceIDs: ["host-evidence-1"],
  }])

  const evidence = next.evidence.at(-1)
  assert.equal(evidence.trust, "verifier")
  assert.equal(evidence.kind, "runtime")
  assert.equal(evidence.passed, true)
})
