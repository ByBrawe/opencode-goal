import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "../dist/verification/evidence.js"

test("goal state round-trips through project-local atomic store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-store-"))
  try {
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID: "session-a", objective: "ship", checks: ["npm test"] })
    await store.save(goal)
    const loaded = await store.load("session-a")
    assert.deepEqual(loaded, goal)
    assert.match(store.fileFor("session-a"), /\.opencode[\\/]goals/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("replaced and cleared goals are archived without polluting live recovery state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-history-store-"))
  try {
    const store = new GoalStore(root)
    const first = createGoal({ sessionID: "session-a", objective: "first goal", now: 100 })
    const completed = { ...first, status: "completed", completionSummary: "done", updatedAt: 200 }
    await store.save(completed)

    const second = createGoal({ sessionID: "session-a", objective: "second goal", now: 300 })
    await store.save(second)

    let history = await store.history("session-a")
    assert.equal(history.length, 1)
    assert.equal(history[0].reason, "replaced")
    assert.deepEqual(history[0].goal, completed)
    assert.deepEqual(await store.list(), [second], "archive files must not be treated as startup-live goals")

    await store.clear("session-a")
    assert.equal(await store.load("session-a"), null)
    assert.deepEqual(await store.list(), [])

    history = await store.history("session-a")
    assert.equal(history.length, 2)
    assert.equal(history[0].goal.id, second.id)
    assert.equal(history[0].reason, "cleared")
    assert.equal(history[1].goal.id, first.id)
    assert.equal(history[1].reason, "replaced")
    assert.match(store.archiveFileFor("session-a", first.id), /\.opencode[\\/]goals[\\/]history/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("completed archived goal cannot be restored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-restore-complete-"))
  try {
    const store = new GoalStore(root)
    const first = createGoal({ sessionID: "session-a", objective: "already done", now: 100 })
    const completed = { ...first, status: "completed", completionSummary: "done", updatedAt: 200 }
    await store.save(completed)
    const second = createGoal({ sessionID: "session-a", objective: "temporary", now: 300 })
    await store.save(second)
    await store.clear("session-a")

    const result = await store.restore("session-a", first.id.slice(0, 12), 400)
    assert.equal(result.ok, false)
    assert.equal(result.reason, "completed")
    assert.equal(await store.load("session-a"), null)
    assert.equal((await store.history("session-a")).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("host file evidence uses predeclared contract and can prove it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-file-"))
  try {
    await writeFile(path.join(root, "README.md"), "Verified Goal Mode\n", "utf8")
    let goal = createGoal({ sessionID: "s1", objective: "docs", files: [{ file: "README.md", contains: "Goal Mode" }] })
    const req = goal.requirements.find((item) => item.verification === "file")
    const checked = await recordFileEvidence(goal, { root, requirementID: req.id })
    assert.equal(checked.evidence.passed, true)
    goal = proveRequirementsFromEvidence(checked.goal, checked.evidence.id)
    assert.equal(goal.requirements.find((item) => item.id === req.id).status, "proven")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file verification contract cannot escape project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-path-"))
  try {
    const goal = createGoal({ sessionID: "s1", objective: "bad", files: [{ file: "../secret.txt" }] })
    const req = goal.requirements.find((item) => item.verification === "file")
    await assert.rejects(() => recordFileEvidence(goal, { root, requirementID: req.id }), /escapes the project root/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
