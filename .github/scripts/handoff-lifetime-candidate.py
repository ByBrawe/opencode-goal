from pathlib import Path
import sys


def once(text, before, after):
    assert text.count(before) == 1, ('candidate anchor changed', before)
    return text.replace(before, after, 1)


if sys.argv[1] == 'tests':
    Path('test/opencode2-handoff-lifetime.test.mjs').write_text(r'''import test from "node:test"
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
''', encoding='utf-8')
    p = Path('scripts/opencode2-unit-handoff-canary.mjs')
    s = p.read_text(encoding='utf-8')
    s = once(s, 'const CREATE_COMMAND = `ship three units --accept', 'const OBJECTIVE = "ship three units. " + "Preserve the complete user contract across native sessions. ".repeat(32) + "REQUIRED_OBJECTIVE_TAIL_7a31"\nconst CONSTRAINT = "Do not publish packages or change unrelated files."\nconst CREATE_COMMAND = `${OBJECTIVE} --constraint ${JSON.stringify(CONSTRAINT)} --accept')
    s = once(s, '      currentUserText: current.userText,', '      currentUserText: current.userText,\n      fullObjectiveVisible: (body.messages || []).some(message => contentText(message.content).includes(OBJECTIVE)),\n      constraintVisible: (body.messages || []).some(message => contentText(message.content).includes(CONSTRAINT)),')
    s = once(s, '    const firstAutonomous = autonomousRequests[0]', '    assert.equal(autonomousRequests.every(item => item.fullObjectiveVisible && item.constraintVisible), true, "full Goal contract missing from a native unit session model request")\n    const firstAutonomous = autonomousRequests[0]')
    p.write_text(s, encoding='utf-8')
    sys.exit(0)

assert sys.argv[1] == 'fix'
p = Path('src/opencode2/experimental.ts')
s = p.read_text(encoding='utf-8')
s = once(s, '    const discardPreparedUnitHandoff = async (\n      directory: string,\n      target: GoalState,\n    ): Promise<void> => {\n      try {', '    const discardPreparedUnitHandoff = async (\n      directory: string,\n      target: GoalState,\n    ): Promise<void> => {\n      if (lifecycleAbort.signal.aborted) return\n      try {')
s = once(s, '        const current = await store.load(target.sessionID)\n        if (current?.id', '        const current = await store.load(target.sessionID)\n        if (lifecycleAbort.signal.aborted) return\n        if (current?.id')
s = once(s, '      if (typeof ctx.session.delete === "function") {\n        await Promise.resolve(ctx.session.delete({ sessionID: target.sessionID }))', '      if (lifecycleAbort.signal.aborted) return\n      if (typeof ctx.session.delete === "function") {\n        await Promise.resolve(ctx.session.delete({ sessionID: target.sessionID }))')
s = once(s, '    ): Promise<GoalState> => {\n      const handoff = target.unitRotation?.handoff', '    ): Promise<GoalState> => {\n      if (lifecycleAbort.signal.aborted) throw new Error("Native Goal handoff is disposed")\n      const handoff = target.unitRotation?.handoff')
s = once(s, '      const admittedID = firstString(record(admitted)?.id, nestedRecord(admitted, "data")?.id)', '      // An already-started admission may settle after unload. Preserve the\n      // prepared record and inbox ID for a fresh instance; do not roll it back.\n      if (lifecycleAbort.signal.aborted) throw new Error("Native Goal handoff is disposed")\n      const admittedID = firstString(record(admitted)?.id, nestedRecord(admitted, "data")?.id)')
s = once(s, '      if (handoffDispatching.has(target.sessionID)) return true', '      if (lifecycleAbort.signal.aborted || handoffDispatching.has(target.sessionID)) return true')
s = once(s, '        const resumedID = firstString(record(resumed)?.id, nestedRecord(resumed, "data")?.id)', '        if (lifecycleAbort.signal.aborted) return true\n        const resumedID = firstString(record(resumed)?.id, nestedRecord(resumed, "data")?.id)')
s = once(s, '    ): Promise<boolean> => {\n      const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })\n      let source = await store.load(sourceSnapshot.sessionID)', '    ): Promise<boolean> => {\n      // Returning handled after unload prevents the old owner falling back to\n      // another continuation. A new instance recovers these durable phases.\n      if (lifecycleAbort.signal.aborted) return true\n      const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })\n      let source = await store.load(sourceSnapshot.sessionID)')
s = once(s, '      let target = await store.load(targetSnapshot.sessionID)\n      if (!source', '      let target = await store.load(targetSnapshot.sessionID)\n      if (lifecycleAbort.signal.aborted) return true\n      if (!source')
s = once(s, '        } catch {\n          // Admission happens before source ownership', '        } catch {\n          if (lifecycleAbort.signal.aborted) return true\n          // Admission happens before source ownership')
s = once(s, '      source = await store.load(source.sessionID)\n      target = await store.load(target.sessionID)\n      if (!source', '      if (lifecycleAbort.signal.aborted) return true\n      source = await store.load(source.sessionID)\n      target = await store.load(target.sessionID)\n      if (lifecycleAbort.signal.aborted) return true\n      if (!source')
s = once(s, '          await store.save(terminal)\n          source = terminal', '          await store.save(terminal)\n          if (lifecycleAbort.signal.aborted) return true\n          source = terminal')
s = once(s, '        target = await store.load(target.sessionID)\n        if (!target)', '        target = await store.load(target.sessionID)\n        if (lifecycleAbort.signal.aborted) return true\n        if (!target)')
s = once(s, '          await store.save(active)\n          target = active', '          await store.save(active)\n          if (lifecycleAbort.signal.aborted) return true\n          target = active')
s = once(s, '      if (!source.unitRotation || !unitRotationNeeded(source, nextUnit)) return false', '      if (lifecycleAbort.signal.aborted) return true\n      if (!source.unitRotation || !unitRotationNeeded(source, nextUnit)) return false')
s = once(s, '        return await withUnitHandoffLease(directory, source.id, async () => {\n          const freshSource', '        return await withUnitHandoffLease(directory, source.id, async () => {\n          if (lifecycleAbort.signal.aborted) return true\n          const freshSource')
s = once(s, '          const freshSource = await new GoalStore(directory).load(source.sessionID)\n          if (!freshSource', '          const freshSource = await new GoalStore(directory).load(source.sessionID)\n          if (lifecycleAbort.signal.aborted) return true\n          if (!freshSource')
s = once(s, '          let target = await findPreparedUnitHandoff(directory, freshSource, nextUnit)\n          if (!target)', '          let target = await findPreparedUnitHandoff(directory, freshSource, nextUnit)\n          if (lifecycleAbort.signal.aborted) return true\n          if (!target)')
s = once(s, '            const targetSessionID = firstString(record(created)?.id, nestedRecord(created, "data")?.id)', '            if (lifecycleAbort.signal.aborted) return true\n            const targetSessionID = firstString(record(created)?.id, nestedRecord(created, "data")?.id)')
s = once(s, '            } catch {\n              if (typeof ctx.session.delete === "function")', '            } catch {\n              if (lifecycleAbort.signal.aborted) return true\n              if (typeof ctx.session.delete === "function")')
s = once(s, '      } catch {\n        // Before the terminal source write', '      } catch {\n        if (lifecycleAbort.signal.aborted) return true\n        // Before the terminal source write')
s = once(s, '        const latest = await new GoalStore(directory).load(source.sessionID).catch(() => null)\n        if (latest?.status', '        const latest = await new GoalStore(directory).load(source.sessionID).catch(() => null)\n        if (lifecycleAbort.signal.aborted) return true\n        if (latest?.status')
s = once(s, '      for (const target of goals) {\n        const handoff', '      for (const target of goals) {\n        if (lifecycleAbort.signal.aborted) return\n        const handoff')
s = once(s, '        if (!source) continue\n        await withUnitHandoffLease(directory, target.id, async () => {', '        if (lifecycleAbort.signal.aborted) return\n        if (!source) continue\n        await withUnitHandoffLease(directory, target.id, async () => {\n          if (lifecycleAbort.signal.aborted) return')
s = once(s, '          const freshTarget = await store.load(target.sessionID)\n          if (!freshSource', '          const freshTarget = await store.load(target.sessionID)\n          if (lifecycleAbort.signal.aborted) return\n          if (!freshSource')
p.write_text(s, encoding='utf-8')
Path('docs/OPENCODE2-HANDOFF-LIFETIME.md').write_text('''# Native unit-handoff unload boundary

An admission, native resume, store read, or store write that started while the
plugin was alive can settle after unload. The retired instance must not start
another host request, retire the source owner, activate a target, or erase a
prepared target based on that late result. Handoff paths now re-check plugin
cancellation after asynchronous boundaries and before the next side effect.

Pending admission remains prepared with its existing durable inbox ID. A late
transport failure after unload is not permission to delete the target. An
already-persisted terminal source stays terminal; target activation is left to
a fresh instance. A resume that already started is not interrupted and its late
result does not authorize a new dispatched-state write by the retired instance.
A fresh instance recovers through the existing state machine and the same inbox
ID, without resetting Goal identity, revision, evidence, budgets, cumulative
usage, or the revision turn baseline. No schema change is required.

This is not cancellation of native model/tool/compaction execution. An in-flight
host operation or atomic persistence write may still finish. A session creation
already accepted by the host may leave an unused empty native session if unload
occurs before its Goal target is recorded; it is never resumed by the retired
instance. The guards do not claim to redesign crash recovery or cancel host IO.

`test/opencode2-handoff-lifetime.test.mjs` holds actual admission, rejection,
resume, and source-terminal persistence boundaries. It waits for the Goal lease
to release, checks for no post-unload host/persistence side effects, then loads
a fresh plugin and proves same-ID recovery and unchanged cumulative accounting.
The tests run through the shipped server entry, not a copied handoff algorithm.

The real three-session canary now uses an objective longer than the reminder
preview plus a separate constraint. It checks full model-visible messages, not
just the latest user-role message: the native context hook already carries the
complete persisted contract. A short reminder alone is not a context-loss bug.
This is deterministic provider contract coverage, not a live-model benchmark.
''', encoding='utf-8')
