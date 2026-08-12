import test from "node:test"
import assert from "node:assert/strict"
import { guardSemanticProcessResults, inferProcessTurnExpectation } from "../dist/verification/process.js"

function goal(text) {
  return {
    revision: 1,
    requirements: [{
      id: "req-process",
      text,
      required: true,
      status: "pending",
      evidenceIDs: [],
      verification: "semantic",
      source: "objective",
      updatedAt: Date.now(),
    }],
  }
}

function hostEvidence({ turns, mutations }) {
  return [
    {
      id: "goal-runtime-turns-r1",
      kind: "runtime",
      trust: "host",
      summary: `turns ${turns}`,
      createdAt: Date.now(),
      goalRevision: 1,
      requirementIDs: [],
      source: "goal-runtime",
      passed: true,
      metadata: { turns },
    },
    {
      id: "goal-runtime-progress-r1",
      kind: "runtime",
      trust: "host",
      summary: `mutations ${mutations}`,
      createdAt: Date.now(),
      goalRevision: 1,
      requirementIDs: [],
      source: "goal-runtime",
      passed: true,
      metadata: { mutations },
    },
  ]
}

function weakProven() {
  return [{
    requirementID: "req-process",
    verdict: "proven",
    reason: "Weak verifier incorrectly claims the final value proves the process.",
    evidence: [{ path: "1.json", quote: '"value": 10' }],
    hostEvidenceIDs: ["goal-runtime-turns-r1", "goal-runtime-progress-r1"],
  }]
}

test("infers exact English multi-turn cadence and per-turn mutation requirement", () => {
  assert.deepEqual(
    inferProcessTurnExpectation("Objective achieved: perform exactly 10 separate Goal turns; in each turn increment 1.json value by exactly 1"),
    { turns: 10, mode: "exactly", requireMutationPerTurn: true },
  )
})

test("infers Turkish multi-turn cadence and per-turn mutation requirement", () => {
  assert.deepEqual(
    inferProcessTurnExpectation("Objective achieved: 10 ayrı goal turu boyunca her goal turunda 1.json value değerini 1 artır"),
    { turns: 10, mode: "exactly", requireMutationPerTurn: true },
  )
})

test("downgrades a one-turn English batch even when verifier says proven", () => {
  const result = guardSemanticProcessResults(
    goal("Objective achieved: perform exactly 10 separate Goal turns; in each turn increment 1.json value by exactly 1"),
    weakProven(),
    hostEvidence({ turns: 1, mutations: 10 }),
  )[0]

  assert.equal(result.verdict, "unknown")
  assert.match(result.reason, /exactly 10 Goal turns/i)
  assert.match(result.reason, /observed only 1/i)
})

test("downgrades a one-turn Turkish batch even when verifier says proven", () => {
  const result = guardSemanticProcessResults(
    goal("Objective achieved: 10 ayrı goal turu boyunca her goal turunda 1.json value değerini 1 artır"),
    weakProven(),
    hostEvidence({ turns: 1, mutations: 10 }),
  )[0]

  assert.equal(result.verdict, "unknown")
  assert.match(result.reason, /exactly 10 Goal turns/i)
  assert.match(result.reason, /observed only 1/i)
})

test("preserves proven when exact turn and per-turn mutation evidence matches", () => {
  const input = weakProven()
  const result = guardSemanticProcessResults(
    goal("Objective achieved: perform exactly 10 separate Goal turns; in each turn increment 1.json value by exactly 1"),
    input,
    hostEvidence({ turns: 10, mutations: 10 }),
  )[0]

  assert.equal(result.verdict, "proven")
  assert.equal(result.reason, input[0].reason)
})

test("downgrades when turns match but mutations were batched", () => {
  const result = guardSemanticProcessResults(
    goal("Objective achieved: perform exactly 10 separate Goal turns; in each turn increment 1.json value by exactly 1"),
    weakProven(),
    hostEvidence({ turns: 10, mutations: 1 }),
  )[0]

  assert.equal(result.verdict, "unknown")
  assert.match(result.reason, /only 1 distinct mutation fingerprint/i)
})

test("fails an exact cadence when host observed too many turns", () => {
  const result = guardSemanticProcessResults(
    goal("Objective achieved: exactly 10 distinct Goal turns"),
    weakProven(),
    hostEvidence({ turns: 11, mutations: 10 }),
  )[0]

  assert.equal(result.verdict, "failed")
  assert.match(result.reason, /observed 11/i)
})

test("enforces at-least turn requirements without requiring exact equality", () => {
  const text = "Objective achieved: at least 3 separate Goal turns"
  const tooFew = guardSemanticProcessResults(goal(text), weakProven(), hostEvidence({ turns: 2, mutations: 0 }))[0]
  const enough = guardSemanticProcessResults(goal(text), weakProven(), hostEvidence({ turns: 4, mutations: 0 }))[0]

  assert.equal(tooFew.verdict, "unknown")
  assert.equal(enough.verdict, "proven")
})

test("does not reinterpret non-process numeric requirements", () => {
  assert.equal(inferProcessTurnExpectation("Objective achieved: create exactly 10 files"), undefined)
  const result = guardSemanticProcessResults(
    goal("Objective achieved: create exactly 10 files"),
    weakProven(),
    hostEvidence({ turns: 1, mutations: 10 }),
  )[0]
  assert.equal(result.verdict, "proven")
})

test("does not reinterpret within-N-turn budget language as required cadence", () => {
  assert.equal(inferProcessTurnExpectation("Objective achieved: finish this within 10 Goal turns"), undefined)
})
