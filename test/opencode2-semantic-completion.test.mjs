import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { createOpenCode2AutonomousRuntime } from "../dist/opencode2/autonomous-runtime.js"
import { createOpenCode2GoalWorkTools } from "../dist/opencode2/work-tools.js"
import { createOpenCode2SemanticVerifierRuntime } from "../dist/opencode2/semantic-verifier.js"
import { SemanticVerifierUnavailableError } from "../dist/opencode/verifier.js"

function verificationRequest(text) {
  const marker = "Verification request:\n"
  const start = text.indexOf(marker)
  assert.ok(start >= 0)
  const rest = text.slice(start + marker.length)
  const end = rest.indexOf("\n\nCall opencode_goal_verifier_result")
  return JSON.parse(end >= 0 ? rest.slice(0, end) : rest)
}

function own(runtime, sessionID, goal, messageID = "goal-owned-turn") {
  runtime.executionOwnerBySession.set(sessionID, {
    messageID,
    goalID: goal.id,
    revision: goal.revision,
    generation: 1,
    source: "execution",
  })
}

test("V2 completion reaches completed only through host checks/files plus independent semantic proof", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-"))
  try {
    await writeFile(path.join(root, "README.md"), "V2 VERIFIED COMPLETION\n", "utf8")
    const sessionID = "v2-completion"
    const store = new GoalStore(root)
    const goal = createGoal({
      sessionID,
      objective: "ship V2 VERIFIED COMPLETION",
      acceptance: ["README documents V2 VERIFIED COMPLETION"],
      files: [{ file: "README.md", contains: "V2 VERIFIED COMPLETION" }],
      now: 100,
    })
    await store.save(goal)

    let verifier
    let deleted = 0
    const session = {
      async create({ parentID }) {
        assert.equal(parentID, sessionID)
        return { id: "verifier-child" }
      },
      async prompt(input) {
        if (input.resume === false) return { id: "verifier-message" }
        const request = verificationRequest(input.text)
        const result = await verifier.resultTool.execute({
          auditToken: request.auditToken,
          results: request.requirements.map((requirement) => ({
            requirementID: requirement.id,
            verdict: "proven",
            reason: "README contains the exact requested V2 completion proof.",
            evidence: [{ path: "README.md", quote: "V2 VERIFIED COMPLETION" }],
            hostEvidenceIDs: [],
          })),
        }, { sessionID: "verifier-child" })
        assert.equal(result.content, "Semantic verifier result accepted.")
        return { id: "verifier-message" }
      },
      async wait() {},
      async delete() { deleted += 1 },
      async interrupt() {},
    }
    verifier = createOpenCode2SemanticVerifierRuntime(session, async () => root, { timeoutMs: 2_000 })

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal)
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: verifier,
    })

    const nativeStatuses = []
    const result = await work.definitions.opencode_goal_complete.execute(
      { summary: "verified V2 completion shipped" },
      { sessionID, progress: async ({ status }) => nativeStatuses.push(status) },
    )
    assert.equal(result.content, "Goal completed with host and verifier-backed evidence.")
    assert.deepEqual(nativeStatuses, [
      "Running Goal host checks",
      "Verifying declared file contracts",
      "Running independent semantic verification",
      "Finalizing verified Goal completion",
    ])

    const completed = await store.load(sessionID)
    assert.equal(completed.status, "completed")
    assert.equal(completed.requirements.every((item) => item.status === "proven"), true)
    assert.equal(completed.evidence.some((item) => item.trust === "host" && item.kind === "file" && item.passed === true), true)
    assert.equal(completed.evidence.some((item) => item.trust === "verifier" && item.passed === true), true)
    assert.equal(deleted, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 completion pauses fail-closed when independent verifier infrastructure is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-outage-"))
  try {
    const sessionID = "v2-completion-outage"
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "ship safely", now: 100 })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal)
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: {
        async verify() {
          throw new SemanticVerifierUnavailableError("semantic verifier session creation failed: provider offline")
        },
      },
    })

    const result = await work.definitions.opencode_goal_complete.execute(
      { summary: "done" },
      { sessionID },
    )
    assert.match(result.content, /Goal paused/i)
    const paused = await store.load(sessionID)
    assert.equal(paused.status, "paused")
    assert.match(paused.stopReason ?? "", /Independent semantic verification unavailable/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 completion rejects stale verifier result after ordinary user steering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-steering-"))
  try {
    const sessionID = "v2-completion-steering"
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "ship after final review", now: 100 })
    await store.save(goal)

    let release
    let started
    const startedPromise = new Promise((resolve) => { started = resolve })
    const verifyPromise = new Promise((resolve) => { release = resolve })

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal)
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: {
        async verify(_sessionID, evaluated) {
          started()
          await verifyPromise
          return evaluated
        },
      },
    })

    const completion = work.definitions.opencode_goal_complete.execute(
      { summary: "done" },
      { sessionID },
    )
    await startedPromise
    work.markForegroundSteering(sessionID, "new-user-steering")
    release()

    const result = await completion
    assert.match(result.content, /user steering arrived/i)
    assert.equal((await store.load(sessionID)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
