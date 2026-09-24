import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { parseGoalCommand } from "../dist/opencode/command.js"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"
import { GoalStore } from "../dist/persistence/store.js"
import {
  applyOpenCode2ControlPlaneMutation,
  readOpenCode2ControlPlane,
} from "../dist/opencode2/control-plane.js"

test("V2 read-only control plane reuses detailed V1 status/contract/audit/list/doctor/history/queue views", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-control-read-"))
  try {
    const sessionID = "v2-control-read"
    const store = new GoalStore(root)
    const goal = createGoal({
      sessionID,
      objective: "ship control parity",
      acceptance: ["control views agree"],
      budget: { maxTurns: 8 },
      now: 100,
    })
    await store.save(goal)

    const status = await readOpenCode2ControlPlane(root, sessionID, parseGoalCommand("status"))
    assert.match(status, /Goal: ship control parity/)
    assert.match(status, /Budget:/)
    assert.match(status, /Model context:/)

    const contract = await readOpenCode2ControlPlane(root, sessionID, parseGoalCommand("contract"))
    assert.match(contract, /Goal Contract/)
    assert.match(contract, /control views agree/)

    const audit = await readOpenCode2ControlPlane(root, sessionID, parseGoalCommand("audit"))
    assert.match(audit, /Goal Audit/)
    assert.match(audit, /Completion gate:/)

    const list = await readOpenCode2ControlPlane(root, sessionID, parseGoalCommand("list"))
    assert.match(list, /Project Goal snapshots/)
    assert.match(list, /ship control parity/)

    const doctor = await readOpenCode2ControlPlane(root, sessionID, parseGoalCommand("doctor"))
    assert.match(doctor, /Goal storage doctor: OK/)
    assert.match(doctor, /No files were modified/)

    const sequence = new GoalSequenceStore(root)
    await sequence.enqueue(sessionID, { objective: "queued parity" })
    const queue = await readOpenCode2ControlPlane(root, sessionID, parseGoalCommand("queue"))
    assert.match(queue, /Goal Sequence/)
    assert.match(queue, /queued parity/)

    await store.clear(sessionID)
    const history = await readOpenCode2ControlPlane(root, sessionID, parseGoalCommand("history"))
    assert.match(history, /Archived goals/)
    assert.match(history, /ship control parity/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 control mutations preserve V1 budget, archive, restore, and sequence semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-v2-control-write-"))
  try {
    const budgetSession = "v2-budget"
    const store = new GoalStore(root)
    const limited = {
      ...createGoal({
        sessionID: budgetSession,
        objective: "lift budget safely",
        budget: { maxTurns: 1 },
        now: 100,
      }),
      status: "budget_limited",
      usage: { turns: 1, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: [] },
      stopReason: "Goal budget exhausted",
    }
    await store.save(limited)

    const budget = await applyOpenCode2ControlPlaneMutation(
      root,
      budgetSession,
      parseGoalCommand("budget --max-turns 5"),
    )
    assert.ok(budget)
    assert.equal(budget.goal.status, "active")
    assert.equal(budget.goal.budget.maxTurns, 5)
    assert.equal(budget.kickoff, true, "lifting a budget-limited Goal must re-arm autonomous continuation")

    await store.clear(budgetSession)
    const restored = await applyOpenCode2ControlPlaneMutation(
      root,
      budgetSession,
      parseGoalCommand(`restore ${limited.id.slice(0, 12)}`),
    )
    assert.ok(restored)
    assert.equal(restored.goal.status, "paused")
    assert.equal(restored.kickoff, false)
    assert.match(restored.message, /Restored archived goal/)

    await store.clear(budgetSession)
    const pruned = await applyOpenCode2ControlPlaneMutation(
      root,
      budgetSession,
      parseGoalCommand("history prune --keep 1"),
    )
    assert.ok(pruned)
    assert.match(pruned.message, /Pruned Goal history|already fits/)

    const queueSession = "v2-queue"
    let result = await applyOpenCode2ControlPlaneMutation(
      root,
      queueSession,
      parseGoalCommand('add first queued --accept "first done"'),
    )
    assert.ok(result)
    assert.match(result.message, /Queued Goal/)

    result = await applyOpenCode2ControlPlaneMutation(
      root,
      queueSession,
      parseGoalCommand('add second queued --check "npm test"'),
    )
    assert.ok(result)

    const sequence = new GoalSequenceStore(root)
    let state = await sequence.load(queueSession)
    assert.equal(state.items.length, 2)
    const secondID = state.items[1].id

    result = await applyOpenCode2ControlPlaneMutation(
      root,
      queueSession,
      parseGoalCommand(`queue move ${secondID.slice(0, 12)} 1`),
    )
    assert.ok(result)
    state = await sequence.load(queueSession)
    assert.equal(state.items[0].id, secondID)

    result = await applyOpenCode2ControlPlaneMutation(
      root,
      queueSession,
      parseGoalCommand("next"),
    )
    assert.ok(result)
    assert.equal(result.goal.objective, "second queued")
    assert.equal(result.goal.status, "active")
    assert.equal(result.kickoff, true)
    state = await sequence.load(queueSession)
    assert.equal(state.items.length, 1)

    const remainingID = state.items[0].id
    result = await applyOpenCode2ControlPlaneMutation(
      root,
      queueSession,
      parseGoalCommand(`queue remove ${remainingID.slice(0, 12)}`),
    )
    assert.ok(result)
    assert.match(result.message, /Removed queued Goal/)
    assert.equal((await sequence.load(queueSession)).items.length, 0)

    await applyOpenCode2ControlPlaneMutation(root, queueSession, parseGoalCommand("add final queued"))
    result = await applyOpenCode2ControlPlaneMutation(root, queueSession, parseGoalCommand("queue clear"))
    assert.ok(result)
    assert.match(result.message, /Cleared 1 queued Goal/)
    assert.equal((await sequence.load(queueSession)).items.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
