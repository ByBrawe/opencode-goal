import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { markHostProgress } from "../dist/runtime/progress.js"
import { normalizeNativeTodos, observeTodoPlan } from "../dist/runtime/todo-plan.js"
import { applySemanticVerifierResults } from "../dist/verification/semantic.js"
import { createOpenCode2AutonomousRuntime } from "../dist/opencode2/autonomous-runtime.js"
import {
  createOpenCode2GoalWorkTools,
  OPENCODE2_GOAL_WORK_TOOLS,
} from "../dist/opencode2/work-tools.js"

function own(runtime, sessionID, goal, messageID, generation = 1) {
  runtime.executionOwnerBySession.set(sessionID, {
    messageID,
    goalID: goal.id,
    revision: goal.revision,
    generation,
    source: "execution",
  })
}

function contextEvent(sessionID, messageID) {
  return {
    sessionID,
    messages: [{ id: messageID, role: "user", content: "goal turn" }],
    tools: Object.fromEntries(OPENCODE2_GOAL_WORK_TOOLS.map((name) => [name, {}])),
  }
}

test("V2 Goal work tools are visible only to exact Goal-owned execution and preserve host/file semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-work-tools-"))
  try {
    await writeFile(path.join(root, "proof.txt"), "OK\n", "utf8")
    const sessionID = "v2-work-tools"
    const store = new GoalStore(root)
    const goal = createGoal({
      sessionID,
      objective: "ship proof",
      files: [{ file: "proof.txt", contains: "OK" }],
      now: 100,
    })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-1")
    const tools = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: { async verify(_sessionID, current) { return current } },
    })

    const foreign = contextEvent(sessionID, "ordinary-user")
    assert.equal(tools.handleContext(foreign), false)
    assert.deepEqual(Object.keys(foreign.tools), [], "ordinary foreground execution must not see Goal work tools")

    const owned = contextEvent(sessionID, "goal-turn-1")
    assert.equal(tools.handleContext(owned), true)
    assert.deepEqual(Object.keys(owned.tools).sort(), [...OPENCODE2_GOAL_WORK_TOOLS].sort())

    const progress = await tools.definitions.opencode_goal_progress.execute(
      { summary: "checkpoint", next: "verify proof" },
      { sessionID },
    )
    assert.match(progress.content, /not completion evidence/i)
    let latest = await store.load(sessionID)
    assert.equal(latest.progressNotes.length, 1)
    assert.equal(latest.progressRevision, 0, "model-authored checkpoint must not manufacture verified progress")

    const fileRequirement = latest.requirements.find((item) => item.verification === "file")
    assert.ok(fileRequirement)
    const nativeStatuses = []
    const evidence = await tools.definitions.opencode_goal_evidence_file.execute(
      { requirementID: fileRequirement.id },
      { sessionID, progress: async ({ status }) => nativeStatuses.push(status) },
    )
    assert.deepEqual(nativeStatuses, ["Verifying declared file evidence"])
    assert.match(evidence.content, /proof\.txt/i)
    latest = await store.load(sessionID)
    assert.equal(latest.requirements.find((item) => item.id === fileRequirement.id)?.status, "proven")
    assert.equal(latest.evidence.some((item) => item.trust === "host" && item.kind === "file" && item.passed === true), true)

    autonomousRuntime.executionOwnerBySession.delete(sessionID)
    const rejected = await tools.definitions.opencode_goal_wait_for_user.execute(
      { reason: "need approval" },
      { sessionID },
    )
    assert.match(rejected.content, /not owned by the current Goal execution/i)
    assert.equal((await store.load(sessionID)).status, "active")

    own(autonomousRuntime, sessionID, latest, "goal-turn-2", 2)
    const waiting = await tools.definitions.opencode_goal_wait_for_user.execute(
      { reason: "need approval", needed: "user confirms release" },
      { sessionID },
    )
    assert.match(waiting.content, /waiting for user input/i)
    latest = await store.load(sessionID)
    assert.equal(latest.status, "waiting_user")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 blocker tool requires distinct owned Goal turns and blocks only on the third repeat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-blocker-"))
  try {
    const sessionID = "v2-blocker"
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "ship despite blocker", now: 100 })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    const tools = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: { async verify(_sessionID, current) { return current } },
    })

    for (const [index, expected] of ["active", "active", "blocked"].entries()) {
      const current = await store.load(sessionID)
      own(autonomousRuntime, sessionID, current, `goal-turn-${index + 1}`, index + 1)
      const result = await tools.definitions.opencode_goal_blocked.execute(
        { reason: "upstream service unavailable", key: "upstream-service" },
        { sessionID },
      )
      const latest = await store.load(sessionID)
      assert.equal(latest.status, expected)
      assert.equal(latest.blockerAudit?.consecutiveTurns, index + 1)
      assert.match(result.content, index === 2 ? /blocked after 3/i : new RegExp(`${index + 1}\/3`))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 work tool retries when another writer commits before it saves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-work-tools-stale-"))
  const originalLoad = GoalStore.prototype.load
  const originalSave = GoalStore.prototype.save
  let armed = false
  let injected = false
  GoalStore.prototype.load = async function (sessionID, ...rest) {
    const snapshot = await originalLoad.call(this, sessionID, ...rest)
    if (armed && !injected && snapshot && sessionID === "v2-work-tools-stale") {
      injected = true
      const competitor = new GoalStore(root)
      const current = await originalLoad.call(competitor, sessionID)
      await originalSave.call(competitor, {
        ...current,
        stopReason: "competing plugin writer",
        updatedAt: current.updatedAt + 1,
      })
    }
    return snapshot
  }
  try {
    const sessionID = "v2-work-tools-stale"
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "survive concurrent writes", now: 100 })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-stale")
    const tools = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: { async verify(_sessionID, current) { return current } },
    })

    armed = true
    const progress = await tools.definitions.opencode_goal_progress.execute(
      { summary: "checkpoint under contention" },
      { sessionID },
    )
    assert.match(progress.content, /Checkpoint recorded/i)

    const latest = await store.load(sessionID)
    assert.equal(latest.stopReason, "competing plugin writer")
    assert.equal(latest.progressNotes.length, 1)
  } finally {
    GoalStore.prototype.load = originalLoad
    GoalStore.prototype.save = originalSave
    await rm(root, { recursive: true, force: true })
  }
})

function semanticProof(goal) {
  return applySemanticVerifierResults(goal, goal.requirements
    .filter((item) => item.required && item.verification === "semantic")
    .map((item) => ({
      requirementID: item.id,
      verdict: "proven",
      reason: "race-test host observation",
      evidence: [{ path: "README.md", quote: "RACE PROOF" }],
      hostEvidenceIDs: [],
    })))
}

test("V2 completion re-verifies when progress changes during semantic verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-progress-race-"))
  try {
    await writeFile(path.join(root, "README.md"), "RACE PROOF\n", "utf8")
    const sessionID = "v2-completion-progress-race"
    const store = new GoalStore(root)
    const competitor = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "complete after a concurrent progress write", now: 100 })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-progress-race")
    let calls = 0
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: {
        async verify(_sessionID, current) {
          calls += 1
          if (calls === 1) {
            const latest = await competitor.load(sessionID)
            await competitor.save(markHostProgress(latest, {
              fingerprint: "race:progress-during-verification",
              source: "test",
              now: latest.updatedAt + 1,
            }))
          }
          return semanticProof(current)
        },
      },
    })

    const result = await work.definitions.opencode_goal_complete.execute(
      { summary: "completed after re-verification" },
      { sessionID },
    )
    assert.equal(result.content, "Goal completed with host and verifier-backed evidence.")
    assert.equal(calls, 2, "completion must re-run verification against the changed progress snapshot")
    const completed = await store.load(sessionID)
    assert.equal(completed.status, "completed")
    assert.deepEqual(completed.progressFingerprints, ["race:progress-during-verification"])
    assert.equal(completed.observedProgressRevision, completed.progressRevision)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 completion fails closed when requirements change during semantic verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-requirement-race-"))
  try {
    await writeFile(path.join(root, "README.md"), "RACE PROOF\n", "utf8")
    const sessionID = "v2-completion-requirement-race"
    const store = new GoalStore(root)
    const competitor = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "original objective", now: 100 })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-requirement-race")
    let calls = 0
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: {
        async verify(_sessionID, current) {
          calls += 1
          const latest = await competitor.load(sessionID)
          await competitor.save(editGoal(latest, {
            objective: "replacement objective during verification",
            now: latest.updatedAt + 1,
          }))
          return semanticProof(current)
        },
      },
    })

    const result = await work.definitions.opencode_goal_complete.execute(
      { summary: "must not complete stale work" },
      { sessionID },
    )
    assert.match(result.content, /changed, paused, or stopped while verification was running/i)
    assert.equal(calls, 1)
    const latest = await store.load(sessionID)
    assert.equal(latest.status, "active")
    assert.equal(latest.revision, 2)
    assert.equal(latest.objective, "replacement objective during verification")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 completion re-verifies when a competing writer commits before the final save", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-save-race-"))
  const originalSave = GoalStore.prototype.save
  let injected = false
  try {
    await writeFile(path.join(root, "README.md"), "RACE PROOF\n", "utf8")
    const sessionID = "v2-completion-save-race"
    const store = new GoalStore(root)
    const competitor = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "complete despite a save collision", now: 100 })
    await store.save(goal)

    GoalStore.prototype.save = async function (state, ...rest) {
      if (!injected && state.sessionID === sessionID && state.status === "completed") {
        injected = true
        const latest = await competitor.load(sessionID)
        await originalSave.call(competitor, markHostProgress(latest, {
          fingerprint: "race:progress-before-completion-save",
          source: "test",
          now: latest.updatedAt + 1,
        }))
      }
      return originalSave.call(this, state, ...rest)
    }

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-save-race")
    let calls = 0
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: {
        async verify(_sessionID, current) {
          calls += 1
          return semanticProof(current)
        },
      },
    })

    const result = await work.definitions.opencode_goal_complete.execute(
      { summary: "completed after store collision" },
      { sessionID },
    )
    assert.equal(injected, true, "the competing save must be injected")
    assert.equal(result.content, "Goal completed with host and verifier-backed evidence.")
    assert.equal(calls, 2, "the stale completion save must re-verify the fresher progress snapshot")
    const completed = await store.load(sessionID)
    assert.equal(completed.status, "completed")
    assert.deepEqual(completed.progressFingerprints, ["race:progress-before-completion-save"])
  } finally {
    GoalStore.prototype.save = originalSave
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 completion re-reads target artifacts changed during semantic verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-file-race-"))
  try {
    await writeFile(path.join(root, "README.md"), "RACE PROOF\n", "utf8")
    await writeFile(path.join(root, "proof.txt"), "GOOD\n", "utf8")
    const sessionID = "v2-completion-file-race"
    const store = new GoalStore(root)
    const goal = createGoal({
      sessionID,
      objective: "complete only with current target artifacts",
      files: [{ file: "proof.txt", contains: "GOOD" }],
      now: 100,
    })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-file-race")
    let calls = 0
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: {
        async verify(_sessionID, current) {
          calls += 1
          if (calls === 1) await writeFile(path.join(root, "proof.txt"), "BAD\n", "utf8")
          return semanticProof(current)
        },
      },
    })

    const result = await work.definitions.opencode_goal_complete.execute(
      { summary: "must not complete with a stale target artifact" },
      { sessionID },
    )
    assert.equal(calls, 2, "the changed target artifact must force re-verification")
    assert.match(result.content, /Completion rejected/i)
    const latest = await store.load(sessionID)
    assert.equal(latest.status, "active")
    const fileRequirement = latest.requirements.find((item) => item.verification === "file")
    assert.equal(fileRequirement?.status, "failed")
    assert.equal(latest.evidence.some((item) => item.kind === "file" && item.passed === false), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 file evidence re-reads the target file after a stale collision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-evidence-reread-"))
  const originalSave = GoalStore.prototype.save
  let injected = false
  try {
    await writeFile(path.join(root, "proof.txt"), "GOOD\n", "utf8")
    const sessionID = "v2-evidence-reread"
    const store = new GoalStore(root)
    const competitor = new GoalStore(root)
    const goal = createGoal({
      sessionID,
      objective: "record fresh file evidence",
      files: [{ file: "proof.txt", contains: "GOOD" }],
      now: 100,
    })
    await store.save(goal)

    GoalStore.prototype.save = async function (state, ...rest) {
      if (!injected && state.evidence.some((item) => item.kind === "file" && item.source === "proof.txt")) {
        injected = true
        await writeFile(path.join(root, "proof.txt"), "BAD\n", "utf8")
        const latest = await competitor.load(sessionID)
        await originalSave.call(competitor, {
          ...latest,
          stopReason: "competing evidence writer",
          updatedAt: latest.updatedAt + 1,
        })
      }
      return originalSave.call(this, state, ...rest)
    }

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-evidence-reread")
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: { async verify(_sessionID, current) { return current } },
    })
    const requirement = goal.requirements.find((item) => item.verification === "file")
    assert.ok(requirement)
    const result = await work.definitions.opencode_goal_evidence_file.execute(
      { requirementID: requirement.id },
      { sessionID },
    )
    assert.equal(injected, true, "the competing evidence save must be injected")
    assert.match(result.content, /Could not verify proof\.txt/i)
    const latest = await store.load(sessionID)
    assert.equal(latest.stopReason, "competing evidence writer")
    const evidence = latest.evidence.find((item) => item.kind === "file" && item.source === "proof.txt")
    assert.equal(evidence?.passed, false, "the retry must read the changed file instead of reusing the first read")
    assert.notEqual(latest.requirements.find((item) => item.id === requirement.id)?.status, "proven")
  } finally {
    GoalStore.prototype.save = originalSave
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 completion cannot close work added to the Todo plan during verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-completion-todo-race-"))
  try {
    await writeFile(path.join(root, "README.md"), "RACE PROOF\n", "utf8")
    const sessionID = "v2-completion-todo-race"
    const store = new GoalStore(root)
    const competitor = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "complete only after the plan is clear", now: 100 })
    await store.save(goal)

    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    own(autonomousRuntime, sessionID, goal, "goal-turn-todo-race")
    const todos = normalizeNativeTodos([
      { id: "race", content: "Finish work discovered during verification", status: "in_progress" },
    ])
    assert.ok(todos)
    let calls = 0
    const work = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async () => root,
      semanticVerifier: {
        async verify(_sessionID, current) {
          calls += 1
          if (calls === 1) {
            const latest = await competitor.load(sessionID)
            await competitor.save(observeTodoPlan(latest, todos, latest.updatedAt + 1))
          }
          return semanticProof(current)
        },
      },
    })

    const result = await work.definitions.opencode_goal_complete.execute(
      { summary: "must not complete with unfinished discovered work" },
      { sessionID },
    )
    assert.equal(calls, 2, "the changed Todo plan must force re-verification")
    assert.match(result.content, /Completion rejected/i)
    assert.match(result.content, /unfinished work/i)
    const latest = await store.load(sessionID)
    assert.equal(latest.status, "active")
    assert.equal(latest.todoPlan?.inProgress, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
