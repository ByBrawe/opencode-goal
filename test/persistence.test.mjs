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
