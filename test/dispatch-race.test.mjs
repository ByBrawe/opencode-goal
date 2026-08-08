import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function readGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

test("edit aborts a dispatched continuation even before assistant ownership event arrives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-pre-assistant-edit-"))
  let resolvePrompt
  let promptCount = 0
  let abortCount = 0
  try {
    const client = {
      session: {
        prompt() {
          promptCount += 1
          return new Promise((resolve) => { resolvePrompt = resolve })
        },
        async abort() {
          abortCount += 1
          return true
        },
      },
    }
    const hooks = await OpenCodeGoalPlugin({ client, directory: root })
    const initial = { parts: [{ type: "text", text: "raw" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "s1", arguments: "old objective" },
      initial,
    )
    await hooks["chat.message"](
      { sessionID: "s1", messageID: "u1", agent: "build" },
      { message: { id: "u1" }, parts: initial.parts },
    )

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    await tick()
    assert.equal(promptCount, 1, "continuation should be dispatched")

    const edited = { parts: [{ type: "text", text: "edit" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "s1", arguments: "edit new objective" },
      edited,
    )

    assert.equal(abortCount, 1, "edit must abort the in-flight dispatch before message.updated ownership exists")
    const state = await readGoal(root)
    assert.equal(state.revision, 2)
    assert.equal(state.objective, "new objective")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    await tick()
    assert.equal(promptCount, 1, "the abort-generated idle must be suppressed")

    resolvePrompt?.({})
    await tick()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
