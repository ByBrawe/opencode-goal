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
    await goals.save(goal)
    await sequences.enqueue(sessionID, { objective: "second queued goal" })
    await sequences.enqueue(sessionID, { objective: "third queued goal" })

    const beforeGoal = await goals.load(sessionID)
    const beforeQueue = await sequences.load(sessionID)
    const shown = formatGoalSidebar(root, sessionID)
    assert.match(shown, /ACTIVE · 1\/1 proven/)
    assert.match(shown, /Queue · 2/)
    assert.match(shown, /second queued goal/)
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
