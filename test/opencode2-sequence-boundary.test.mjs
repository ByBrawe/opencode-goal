import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executeOpenCode2GoalControl } from "../dist/opencode2/experimental.js"
import { GoalStore } from "../dist/persistence/store.js"

function context(directory) {
  return {
    options: { directory },
    command: { transform() {} },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }),
      hook() {},
    },
    tool: { transform() {} },
  }
}

test("V2 sequence controls fail closed instead of creating or advancing stable V1 queue state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goals-v2-sequence-boundary-"))
  try {
    const ctx = context(root)
    const sessionID = "v2-sequence-boundary-session"
    const store = new GoalStore(root)

    const add = await executeOpenCode2GoalControl(ctx, "add queued docs", { sessionID, agent: "build" })
    assert.match(add.content, /not enabled yet/i)
    assert.equal(await store.load(sessionID), null, "V2 /goal add must not fall through to live Goal creation")

    await executeOpenCode2GoalControl(ctx, "ship docs", { sessionID, agent: "build" })
    const before = await store.load(sessionID)
    assert.ok(before)

    for (const command of [
      "queue",
      "next",
      "queue clear",
      "queue remove abc123",
      "queue move abc123 1",
    ]) {
      const result = await executeOpenCode2GoalControl(ctx, command, { sessionID, agent: "build" })
      assert.match(result.content, /not enabled yet/i, `${command} should explicitly refuse V2 sequence parity`)
      assert.deepEqual(await store.load(sessionID), before, `${command} must not mutate the live Goal`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
