import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { executeOpenCode2GoalControl } from "../dist/opencode2/experimental.js"
import { GoalStore } from "../dist/persistence/store.js"

function context(directory) {
  return {
    options: { directory },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }),
      hook() {},
    },
    tool: { transform() {} },
  }
}

test("V2 sequence and lifecycle controls stay read-only and never create or advance Goal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-sequence-boundary-"))
  try {
    const ctx = context(root)
    const sessionID = "v2-sequence-boundary-session"
    const store = new GoalStore(root)

    const emptyQueue = await executeOpenCode2GoalControl(ctx, "queue", { sessionID, agent: "build" })
    assert.match(emptyQueue.content, /Goal Sequence/)
    assert.equal(await store.load(sessionID), null, "read-only queue inspection must not create Goal state")

    for (const command of ["add queued docs", "ship docs", "next", "clear"]) {
      const result = await executeOpenCode2GoalControl(ctx, command, { sessionID, agent: "build" })
      assert.match(result.content, /model-visible lifecycle control remains read-only/i, `${command} should refuse V2 mutation`)
      assert.equal(await store.load(sessionID), null, `${command} must not create Goal state`)
    }

    const seeded = createGoal({ sessionID, objective: "existing stable goal" })
    await store.save(seeded)
    const before = await store.load(sessionID)
    assert.ok(before)

    const currentQueue = await executeOpenCode2GoalControl(ctx, "queue", { sessionID, agent: "build" })
    assert.match(currentQueue.content, /Goal Sequence/)
    assert.deepEqual(await store.load(sessionID), before, "queue inspection must not mutate the live Goal")

    for (const command of [
      "pause",
      "resume",
      "edit changed",
      "add queued docs",
      "next",
      "queue clear",
      "queue remove abc123",
      "queue move abc123 1",
      "clear",
    ]) {
      const result = await executeOpenCode2GoalControl(ctx, command, { sessionID, agent: "build" })
      assert.match(result.content, /model-visible lifecycle control remains read-only/i, `${command} should refuse V2 mutation`)
      assert.deepEqual(await store.load(sessionID), before, `${command} must not mutate the live Goal`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
