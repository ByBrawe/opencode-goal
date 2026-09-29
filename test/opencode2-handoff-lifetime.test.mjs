import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../dist/server.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { createUnitHandoffTarget, markUnitHandoffAdmitted, markUnitHandoffSourceTerminal, activateUnitHandoffTarget, observeInitialGoalUnit } from "../dist/opencode2/unit-handoff.js"

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (await check()) return; await pause(10) }
  throw new Error(`Timed out: ${label}`)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function scenario(mode) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goal-handoff-lifetime-"))
  const store = new GoalStore(directory)
  const gate = deferred()
  const calls = [], deleted = [], writesAfterClose = []
  let reached = false, closed = false, stop
  const originalSave = GoalStore.prototype.save
  let source = observeInitialGoalUnit(createGoal({
    sessionID: "handoff-source", objective: "preserve the complete unit contract",
    acceptance: ["all units verified"], constraints: ["do not publish"],
    unitRotation: { command: "unused-host-unit-command", freshSessionPerUnit: true },
    budget: { maxTurns: 20, maxTokens: 500000, maxCost: 25 },
  }), "unit-001")
  source.usage = { ...source.usage, turns: 7, tokens: 123456, cost: 3.25, runtimeMs: 42000, seenMessageIDs: ["old-message"] }
  source.revisionTurnBaseline = 2
  let target = createUnitHandoffTarget(source, "handoff-target", "unit-002")
  if (mode === "resume") {
    target = markUnitHandoffAdmitted(target)
    source = markUnitHandoffSourceTerminal(source, target)
    target = activateUnitHandoffTarget(target)
  }
  await store.save(source)
  await store.save(target)
  const beforeSource = await store.load(source.sessionID)
  const beforeTarget = await store.load(target.sessionID)
  const inboxID = target.unitRotation.handoff.messageID
  const lock = path.join(directory, ".opencode", "goal-handoff-locks", createHash("sha256").update(source.id).digest("hex").slice(0, 32) + ".lock")
  const leaseReleased = () => access(lock).then(() => false, error => { if (error.code === "ENOENT") return true; throw error })
  GoalStore.prototype.save = async function(goal, ...args) {
    if (closed) writesAfterClose.push({ sessionID: goal.sessionID, status: goal.status })
    const result = await originalSave.call(this, goal, ...args)
    if (mode === "source-terminal" && goal.sessionID === source.sessionID && goal.status === "handed_off" && !reached) {
      reached = true
      await gate.promise
    }
    return result
  }
  function context(hold) {
    return {
      location: { directory }, options: { lifecycle: true, autonomous: true },
      command: { transform: async edit => edit({ add() {} }) },
      tool: { transform: async edit => edit({ add() {} }) },
      session: {
        get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }),
        hook: async () => ({ dispose() {} }),
        delete: async ({ sessionID }) => { deleted.push(sessionID) },
        prompt: async input => {
          calls.push({ ...input, afterClose: closed, generation: hold ? "old" : "new" })
          const shouldHold = mode === "resume" ? input.resume === true : input.resume === false
          if (hold && mode !== "source-terminal" && shouldHold && !reached) {
            reached = true
            await gate.promise
          }
          return { id: input.id }
        },
      },
    }
  }
  try {
    stop = await plugin.setup(context(true))
    await waitFor(() => reached, "the intended handoff await")
    closed = true
    await stop()
    if (mode === "admission-reject") gate.reject(new Error("late admission transport failure"))
    else gate.resolve()
    await waitFor(leaseReleased, "old handoff lease release")
    assert.equal(calls.some(call => call.afterClose), false, "handoff dispatched a host request after unload")
    assert.deepEqual(deleted, [], "late admission result must not delete a recovery target after unload")
    assert.deepEqual(writesAfterClose, [], "handoff started a persistence write after unload")
    const savedSource = await store.load(source.sessionID)
    const savedTarget = await store.load(target.sessionID)
    assert.ok(savedTarget, "pending target must remain recoverable")
    assert.equal(savedSource.status, mode === "source-terminal" || mode === "resume" ? "handed_off" : "active")
    assert.equal(savedTarget.unitRotation.handoff.phase, mode === "source-terminal" ? "admitted" : mode === "resume" ? "dispatch_pending" : "prepared")
    for (const field of ["id", "revision", "objective", "requirements", "constraints", "evidence", "budget", "usage", "revisionTurnBaseline"]) {
      assert.deepEqual(savedSource[field], beforeSource[field], `source ${field} changed on unload`)
      assert.deepEqual(savedTarget[field], beforeTarget[field], `target ${field} changed on unload`)
    }
    assert.equal(savedTarget.unitRotation.handoff.messageID, inboxID)
    GoalStore.prototype.save = originalSave
    closed = false
    stop = await plugin.setup(context(false))
    await waitFor(async () => (await store.load(target.sessionID))?.unitRotation?.handoff?.phase === "dispatched", "fresh plugin recovery")
    await waitFor(leaseReleased, "recovery handoff lease release")
    const recovered = await store.load(target.sessionID)
    assert.equal((await store.load(source.sessionID)).status, "handed_off")
    assert.equal(recovered.status, "active")
    assert.deepEqual(recovered.usage, beforeTarget.usage, "recovery reset cumulative usage")
    assert.deepEqual(recovered.budget, beforeTarget.budget, "recovery reset the budget")
    assert.equal(recovered.revisionTurnBaseline, beforeTarget.revisionTurnBaseline)
    assert.equal(new Set(calls.map(call => call.id)).size, 1, "recovery admitted a new inbox identity")
    assert.equal(calls.every(call => call.id === inboxID), true)
    assert.equal(calls.filter(call => call.generation === "new" && call.resume === true).length, 1)
  } finally {
    gate.resolve()
    await stop?.()
    if (reached) await waitFor(leaseReleased, "final lease release")
    GoalStore.prototype.save = originalSave
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

for (const mode of ["admission", "admission-reject", "resume", "source-terminal"]) {
  test(`native handoff unload fences ${mode} and preserves same-ID recovery`, () => scenario(mode))
}
