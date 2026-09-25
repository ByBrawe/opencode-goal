import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal, pauseGoal, resumeGoal } from "../dist/domain/goal.js"
import {
  activateUnitHandoffTarget,
  createUnitHandoffTarget,
  markUnitHandoffAdmitted,
  markUnitHandoffDispatched,
  markUnitHandoffSourceTerminal,
  observeInitialGoalUnit,
  unitHandoffMessageID,
  unitRotationNeeded,
  withUnitHandoffLease,
} from "../dist/opencode2/unit-handoff.js"

function seededGoal() {
  const goal = createGoal({
    sessionID: "source-session",
    objective: "ship three independently verified units",
    unitRotation: {
      command: "node scripts/current-unit.mjs",
      freshSessionPerUnit: true,
    },
    budget: { maxTurns: 20, maxTokens: 500000, maxCost: 25, maxRuntimeMs: 3600000 },
    now: 100,
  })
  goal.evidence.push({
    id: "evidence-1",
    kind: "file",
    trust: "host",
    summary: "unit 1 proof",
    createdAt: 110,
    goalRevision: goal.revision,
    requirementIDs: [goal.requirements[0].id],
    passed: true,
  })
  goal.usage = {
    turns: 7,
    tokens: 123456,
    cost: 3.25,
    runtimeMs: 42000,
    seenMessageIDs: ["m1", "m2"],
  }
  goal.progressRevision = 5
  goal.observedProgressRevision = 5
  goal.storageGeneration = 9
  return observeInitialGoalUnit(goal, "unit-001", 120)
}

test("unit unchanged stays in the current session and a changed host reading requests rotation", () => {
  const goal = seededGoal()
  assert.equal(unitRotationNeeded(goal, "unit-001"), false)
  assert.equal(unitRotationNeeded(goal, "unit-002"), true)

  const paused = pauseGoal(goal, "user pause", 130)
  assert.equal(unitRotationNeeded(paused, "unit-002"), false)
})

test("prepared handoff preserves Goal identity, evidence, budget, usage, and revision exactly", () => {
  const source = seededGoal()
  const target = createUnitHandoffTarget(source, "target-session", "unit-002", 200)

  assert.equal(target.status, "handoff_pending")
  assert.equal(target.id, source.id)
  assert.equal(target.revision, source.revision)
  assert.equal(target.objective, source.objective)
  assert.deepEqual(target.requirements, source.requirements)
  assert.deepEqual(target.evidence, source.evidence)
  assert.deepEqual(target.budget, source.budget)
  assert.deepEqual(target.usage, source.usage)
  assert.equal(target.progressRevision, source.progressRevision)
  assert.equal(target.observedProgressRevision, source.observedProgressRevision)
  assert.equal(target.sessionID, "target-session")
  assert.equal(target.storageGeneration, 0)
  assert.equal(target.pendingContinuation, true)
  assert.equal(target.unitRotation.currentUnit, "unit-002")
  assert.equal(target.unitRotation.rootSessionID, "source-session")
  assert.equal(target.unitRotation.chainIndex, 1)
  assert.equal(target.unitRotation.previousSessionID, "source-session")
  assert.equal(target.unitRotation.handoff.phase, "prepared")
  assert.ok(unitHandoffMessageID(target)?.startsWith("goal-handoff-"))
})

test("handoff phases keep exactly one runnable Goal owner", () => {
  const source = seededGoal()
  let target = createUnitHandoffTarget(source, "target-session", "unit-002", 200)

  target = markUnitHandoffAdmitted(target, 210)
  assert.equal(source.status, "active")
  assert.equal(target.status, "handoff_pending")
  assert.equal(target.unitRotation.handoff.phase, "admitted")

  const terminal = markUnitHandoffSourceTerminal(source, target, 220)
  assert.equal(terminal.status, "handed_off")
  assert.equal(terminal.unitRotation.nextSessionID, "target-session")
  assert.equal(resumeGoal(terminal, 230).status, "handed_off", "terminal predecessor cannot be resumed")

  target = activateUnitHandoffTarget(target, 230)
  assert.equal(target.status, "active")
  assert.equal(target.unitRotation.handoff.phase, "dispatch_pending")
  assert.equal(target.pendingContinuation, true)

  target = markUnitHandoffDispatched(target, 240)
  assert.equal(target.status, "active")
  assert.equal(target.pendingContinuation, undefined)
  assert.equal(target.unitRotation.handoff.phase, "dispatched")
  assert.equal(target.unitRotation.handoff.dispatchedAt, 240)
})

test("completed or paused Goals never become unit-rotation candidates", () => {
  const goal = seededGoal()
  const completed = { ...goal, status: "completed" }
  const paused = { ...goal, status: "paused" }
  assert.equal(unitRotationNeeded(completed, "unit-002"), false)
  assert.equal(unitRotationNeeded(paused, "unit-002"), false)
})


test("Goal-scoped unit handoff lease serializes concurrent rotation attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-unit-handoff-lock-"))
  try {
    let active = 0
    let peak = 0
    const order = []
    const run = (name, delay) => withUnitHandoffLease(root, "shared-goal-id", async () => {
      active += 1
      peak = Math.max(peak, active)
      order.push(`${name}:start`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      order.push(`${name}:end`)
      active -= 1
    }, 2_000)

    await Promise.all([run("a", 40), run("b", 1)])
    assert.equal(peak, 1)
    assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("handoff retry keeps one durable inbox identity across crash phases", () => {
  const source = seededGoal()
  let target = createUnitHandoffTarget(source, "target-session", "unit-002", 200)
  const messageID = unitHandoffMessageID(target)
  assert.ok(messageID)

  target = markUnitHandoffAdmitted(target, 210)
  const terminal = markUnitHandoffSourceTerminal(source, target, 220)
  target = activateUnitHandoffTarget(target, 230)

  assert.equal(unitHandoffMessageID(target), messageID)
  assert.equal(terminal.status, "handed_off")
  assert.equal(target.status, "active")
  assert.equal(target.unitRotation.handoff.phase, "dispatch_pending")

  const retryView = { ...target, unitRotation: { ...target.unitRotation, handoff: { ...target.unitRotation.handoff } } }
  assert.equal(unitHandoffMessageID(retryView), messageID, "restart/reload must reuse the persisted inbox ID")

  const dispatched = markUnitHandoffDispatched(retryView, 240)
  assert.equal(unitHandoffMessageID(dispatched), messageID)
  assert.equal(dispatched.unitRotation.handoff.phase, "dispatched")
  assert.equal(markUnitHandoffDispatched(dispatched, 250).unitRotation.handoff.phase, "dispatched")
})
