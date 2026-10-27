import test from "node:test"
import assert from "node:assert/strict"
import { guardSemanticProcessResults, inferProcessTurnExpectation } from "../dist/verification/process.js"
import { createGoal } from "../dist/domain/goal.js"
import { applySemanticVerifierResults } from "../dist/verification/semantic.js"
import { completeGoal } from "../dist/verification/audit.js"
import { collectHostAbsenceEvidence, corroborateSemanticVerifierEvidence, semanticVerifierHostEvidence } from "../dist/verification/verifier-evidence.js"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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
    hostEvidence({ turns: 1, mutations: 1 }),
  )[0]

  assert.equal(result.verdict, "unknown")
  assert.match(result.reason, /only 1 distinct mutation fingerprint/i)
})

test("downgrades a one-turn Turkish batch even when verifier says proven", () => {
  const result = guardSemanticProcessResults(
    goal("Objective achieved: 10 ayrı goal turu boyunca her goal turunda 1.json value değerini 1 artır"),
    weakProven(),
    hostEvidence({ turns: 1, mutations: 1 }),
  )[0]

  assert.equal(result.verdict, "unknown")
  assert.match(result.reason, /only 1 distinct mutation fingerprint/i)
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

test("per-turn mutation proof ignores extra assistant tool-loop messages", () => {
  const input = weakProven()
  const result = guardSemanticProcessResults(
    goal("Objective achieved: perform exactly 10 separate Goal turns; in each turn increment 1.json value by exactly 1"),
    input,
    hostEvidence({ turns: 11, mutations: 10 }),
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

test("fails exact per-turn mutation cadence when host observed too many mutation turns", () => {
  const result = guardSemanticProcessResults(
    goal("Objective achieved: perform exactly 10 separate Goal turns; in each turn increment 1.json value by exactly 1"),
    weakProven(),
    hostEvidence({ turns: 11, mutations: 11 }),
  )[0]

  assert.equal(result.verdict, "failed")
  assert.match(result.reason, /observed 11 distinct mutation fingerprint/i)
})

test("fails an exact cadence without per-turn mutations when host observed too many assistant turns", () => {
  const result = guardSemanticProcessResults(
    goal("Objective achieved: exactly 10 distinct Goal turns"),
    weakProven(),
    hostEvidence({ turns: 11, mutations: 0 }),
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


test("a verifier cannot mark generic deliverable complete using only runtime turn counters", () => {
  const given = [{
    requirementID: "req-process",
    verdict: "proven",
    reason: "The assistant says all work is done.",
    evidence: [],
    hostEvidenceIDs: ["goal-runtime-turns-r1", "goal-runtime-progress-r1"],
  }]
  for (const counts of [
    { turns: 0, mutations: 0 },
    { turns: 7, mutations: 0 },
    { turns: 7, mutations: 30 },
  ]) {
    const result = guardSemanticProcessResults(
      goal("Objective achieved: implement src/slug.js with passing tests"),
      given,
      hostEvidence(counts),
    )[0]
    assert.equal(result.verdict, "unknown", "turns and mutation fingerprints cannot establish an implementation")
    assert.match(result.reason, /real file or passing command\/file evidence is required/)
  }
})

test("explicit pure turn-count contract can still use host-observed runtime counters", () => {
  const given = [{
    requirementID: "req-process",
    verdict: "proven",
    reason: "The host has counted the required turns.",
    evidence: [],
    hostEvidenceIDs: ["goal-runtime-turns-r1"],
  }]
  const passed = guardSemanticProcessResults(
    goal("Objective achieved: at least 3 distinct Goal turns"),
    given,
    hostEvidence({ turns: 3, mutations: 0 }),
  )[0]
  assert.equal(passed.verdict, "proven")
})

test("host-corroborated file excerpt satisfies the non-process evidence guard", () => {
  const given = [{
    requirementID: "req-process",
    verdict: "proven",
    reason: "The workspace file was checked by the host.",
    evidence: [{ path: "src/slug.js", quote: "export function slugify" }],
    hostEvidenceIDs: [],
  }]
  const guarded = guardSemanticProcessResults(
    goal("Objective achieved: implement src/slug.js"),
    given,
    hostEvidence({ turns: 1, mutations: 1 }),
  )[0]
  assert.equal(guarded.verdict, "proven")
})

test("passing current host file/command checks are admissible but stale or runtime-only proof is not", () => {
  const current = { id: "host-test-r1", kind: "command", trust: "host",
    passed: true, goalRevision: 1, source: "npm test", requirementIDs: ["check-npm-test"] }
  const given = [{
    requirementID: "req-process", verdict: "proven",
    reason: "Verified host command passed.",
    evidence: [], hostEvidenceIDs: [current.id],
  }]
  const target = goal("Objective achieved: ship passing tests")
  target.requirements.push({
    id: "check-npm-test", text: "Verification command passes: npm test",
    verification: "command", command: "npm test", required: true,
    status: "proven", evidenceIDs: [current.id], updatedAt: Date.now(),
  })
  assert.equal(guardSemanticProcessResults(target, given, [current])[0].verdict, "proven")
  assert.equal(guardSemanticProcessResults(target, given, [{ ...current, goalRevision: 0 }])[0].verdict, "unknown")
  assert.equal(guardSemanticProcessResults(target, given, [{ ...current, passed: false }])[0].verdict, "unknown")
  assert.equal(guardSemanticProcessResults(target, given, [{ ...current, kind: "runtime" }])[0].verdict, "unknown")
  assert.equal(guardSemanticProcessResults(target, given, [{ ...current, requirementIDs: ["unrelated-check"] }])[0].verdict, "unknown", "an unrelated passing command is not deliverable proof")
  assert.equal(guardSemanticProcessResults(target, [{ ...given[0], hostEvidenceIDs: [] }], [current])[0].verdict, "unknown", "uncited host checks do not authorize completion")
})


test("a false done verdict cannot persist completed Goal when no project artifact exists", () => {
  const current = createGoal({
    sessionID: "false-complete-regression",
    objective: "implement src/slug.js with tests",
  })
  const requirement = current.requirements.find((item) => item.verification === "semantic")
  assert.ok(requirement, "a generic Goal requires independent semantic proof")
  const evidence = semanticVerifierHostEvidence(current, "current-model-turn")
  const claims = [{
    requirementID: requirement.id,
    verdict: "proven",
    reason: "The assistant claims it has finished but no target file exists.",
    evidence: [],
    hostEvidenceIDs: evidence.map((item) => item.id),
  }]
  const checked = guardSemanticProcessResults(current, claims, evidence)
  assert.equal(checked[0].verdict, "unknown")
  const considered = applySemanticVerifierResults(current, checked)
  const completed = completeGoal(considered, "All done!")
  assert.equal(completed.audit.ok, false)
  assert.notEqual(completed.goal.status, "completed")
  assert.match(completed.audit.reasons.join(" "), /not proven/)
})


test("mixed implementation-plus-process goal needs both actual deliverable and required turns", () => {
  const objective = goal("Objective achieved: implement src/slug.js across at least 3 distinct Goal turns")
  const records = hostEvidence({ turns: 3, mutations: 7 })
  const weak = [{
    requirementID: "req-process", verdict: "proven",
    reason: "Three turns happened but the target file was never created.",
    evidence: [], hostEvidenceIDs: records.map((item) => item.id),
  }]
  assert.equal(guardSemanticProcessResults(objective, weak, records)[0].verdict, "unknown")
  const realFile = {
    ...weak[0],
    evidence: [{ path: "src/slug.js", quote: "export function slugify" }],
  }
  assert.equal(guardSemanticProcessResults(objective, [realFile], records)[0].verdict, "proven")
  assert.equal(guardSemanticProcessResults(objective, [realFile], hostEvidence({ turns: 1, mutations: 7 }))[0].verdict, "unknown")
})

test("unrelated passing command or README contract cannot prove a named implementation target", () => {
  const objective = goal("Objective achieved: implement src/slug.js")
  objective.requirements.push({
    id: "check-true", text: "Verification command passes: true",
    verification: "command", command: "true", required: true, status: "proven",
    evidenceIDs: ["host-true"], updatedAt: Date.now(),
  })
  objective.requirements.push({
    id: "file-readme", text: "File README.md exists",
    verification: "file", file: "README.md", required: true, status: "proven",
    evidenceIDs: ["host-readme"], updatedAt: Date.now(),
  })
  const records = [
    { id: "host-true", kind: "command", trust: "host", passed: true,
      goalRevision: 1, source: "true", requirementIDs: ["check-true"] },
    { id: "host-readme", kind: "file", trust: "host", passed: true,
      goalRevision: 1, source: "README.md", requirementIDs: ["file-readme"],
      metadata: { exists: true, regularFile: true } },
  ]
  const claimed = [{
    requirementID: "req-process", verdict: "proven", reason: "unrelated checks passed",
    evidence: [], hostEvidenceIDs: records.map((x) => x.id),
  }]
  assert.equal(guardSemanticProcessResults(objective, claimed, records)[0].verdict, "unknown")
  assert.equal(guardSemanticProcessResults(objective, [{ ...claimed[0],
    evidence: [{ path: "src/slug.js", quote: "export function slugify" }],
  }], records)[0].verdict, "proven")
})

test("named deletion can use host-observed absence but not a stale or recreated file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goal-delete-proof-"))
  const objective = createGoal({ sessionID: "deletion-regression", objective: "delete obsolete.txt" })
  const semantic = objective.requirements.find((x) => x.verification === "semantic")
  assert.ok(semantic)
  try {
    const absent = await collectHostAbsenceEvidence(root, objective)
    assert.equal(absent.length, 1)
    assert.equal(absent[0].source, "obsolete.txt")
    assert.equal(absent[0].metadata.absent, true)
    const raw = [{
      requirementID: semantic.id, verdict: "proven",
      reason: "Host independently checked the named file is absent.",
      evidence: [], hostEvidenceIDs: [absent[0].id],
    }]
    const corroborated = await corroborateSemanticVerifierEvidence(root, objective, raw, absent)
    assert.equal(guardSemanticProcessResults(objective, corroborated, absent)[0].verdict, "proven")
    await writeFile(path.join(root, "obsolete.txt"), "recreated")
    await assert.rejects(
      () => corroborateSemanticVerifierEvidence(root, objective, raw, absent),
      /no longer absent/,
    )
    assert.deepEqual(await collectHostAbsenceEvidence(root, objective), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not reinterpret within-N-turn budget language as required cadence", () => {
  assert.equal(inferProcessTurnExpectation("Objective achieved: finish this within 10 Goal turns"), undefined)
})
