import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatGoalSidebar } from "../dist/tui/format.js"
import tuiModule from "../dist/tui/index.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"
import { GoalStore } from "../dist/persistence/store.js"

const directoryLinkType = process.platform === "win32" ? "junction" : "dir"

test("TUI Goal sidebar is read-only and fails visible on unsafe or corrupt storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sidebar-"))
  try {
    const sessionID = "sidebar-session"
    const goals = new GoalStore(root)
    const sequences = new GoalSequenceStore(root)
    const goal = createGoal({ sessionID, objective: "Ship safe sequence support with a long objective" })
    goal.requirements[0].status = "proven"
    goal.usage.turns = 2
    goal.usage.tokens = 1200
    goal.usage.cost = 0.125
    goal.usage.runtimeMs = 65_000
    goal.execution = {
      model: { providerID: "test", modelID: "model-x" },
      modelContext: { contextLimit: 128_000, lastRequestTokens: 18_400, observedAt: goal.createdAt + 1_000 },
    }
    goal.progressNotes.push({ time: goal.createdAt + 2_000, summary: "[host:edit] changed source", next: "" })
    goal.todoPlan = {
      goalRevision: goal.revision,
      digest: `sha256:${"a".repeat(64)}`,
      total: 3,
      pending: 1,
      inProgress: 1,
      completed: 1,
      cancelled: 0,
      observedAt: goal.createdAt + 3_000,
      items: [
        { key: "todo:a:1", content: "Inspect state", status: "completed", order: 0 },
        { key: "todo:b:1", content: "Process batch 2", status: "in_progress", order: 1 },
        { key: "todo:c:1", content: "Validate results", status: "pending", order: 2 },
      ],
    }
    await goals.save(goal)
    await sequences.enqueue(sessionID, { objective: "second queued goal" })
    await sequences.enqueue(sessionID, { objective: "third queued goal" })

    const beforeGoal = await goals.load(sessionID)
    const beforeQueue = await sequences.load(sessionID)
    const shown = formatGoalSidebar(root, sessionID)
    assert.match(shown, /ACTIVE · VERIFIED · r1/)
    assert.match(shown, /turns 2\/∞ · tokens 1\.2K\/∞/)
    assert.match(shown, /cost 0\.1250\/∞/)
    assert.match(shown, /model test\/model-x · context 18K\/128K/)
    assert.match(shown, /progress req 1\/1/)
    assert.match(shown, /plan 1\/3 done · 1 active · 1 pending/)
    assert.match(shown, /→ Process batch 2/)
    assert.match(shown, /host progress .* ago · state update .* ago/)
    assert.match(shown, /current todo in progress/)
    assert.match(shown, /Queue · 2/)
    assert.match(shown, /second queued goal/)

    await writeFile(goals.fileFor(sessionID), `${JSON.stringify({ ...beforeGoal, completionMode: "invalid-mode" }, null, 2)}\n`)
    assert.match(formatGoalSidebar(root, sessionID), /Goal storage unavailable/)
    await writeFile(goals.fileFor(sessionID), `${JSON.stringify(beforeGoal, null, 2)}\n`)

    const continuousSession = "sidebar-continuous"
    await goals.save(createGoal({ sessionID: continuousSession, objective: "watch forever", completionMode: "continuous" }))
    const continuous = formatGoalSidebar(root, continuousSession)
    assert.match(continuous, /ACTIVE · CONTINUOUS · r1/)
    assert.match(continuous, /progress continuous/)
    assert.doesNotMatch(continuous, /\d+%/)

    assert.deepEqual(await goals.load(sessionID), beforeGoal)
    assert.deepEqual(await sequences.load(sessionID), beforeQueue)

    const external = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sidebar-external-"))
    try {
      await rm(path.join(root, ".opencode", "goals"), { recursive: true, force: true })
      await symlink(external, path.join(root, ".opencode", "goals"), directoryLinkType)
      await writeFile(path.join(external, "sentinel.json"), JSON.stringify({ objective: "SHOULD NOT LEAK" }))
      const protectedText = formatGoalSidebar(root, sessionID)
      assert.doesNotMatch(protectedText, /SHOULD NOT LEAK/)
      assert.match(protectedText, /Goal storage unavailable/)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("TUI package entrypoint registers only a read-only sidebar slot", async () => {
  const registrations = []
  await tuiModule.tui({
    slots: { register(value) { registrations.push(value) } },
    state: {
      path: { directory: "/tmp/nonexistent-opencode-goals", worktree: "/tmp/nonexistent-opencode-goals" },
      session: { status() { return undefined }, messages() { return [] } },
    },
  })
  assert.equal(tuiModule.id, "opencode-goal")
  assert.equal(registrations.length, 1)
  assert.equal(typeof registrations[0].slots.sidebar_content, "function")
  assert.match(String(registrations[0].slots.sidebar_content({}, { session_id: "none" })), /OpenCode Goals/)
})
