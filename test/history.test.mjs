import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
  }
}

async function runGoalCommand(hooks, sessionID, argumentsText) {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: argumentsText },
    output,
  )
  return output
}

test("cleared goal remains inspectable and history lookup does not pause the current goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-history-"))
  try {
    const sessionID = "history-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const firstOutput = await runGoalCommand(hooks, sessionID, "ship first release")
    await hooks["chat.message"](
      { sessionID, messageID: "first-command", agent: "build" },
      { message: { id: "first-command" }, parts: firstOutput.parts },
    )
    const first = await store.load(sessionID)
    assert.equal(first.status, "active")

    const clearOutput = await runGoalCommand(hooks, sessionID, "clear")
    await hooks["chat.message"](
      { sessionID, messageID: "clear-command", agent: "build" },
      { message: { id: "clear-command" }, parts: clearOutput.parts },
    )
    assert.equal(await store.load(sessionID), null)
    const archived = await store.history(sessionID)
    assert.equal(archived.length, 1)
    assert.equal(archived[0].goal.id, first.id)
    assert.equal(archived[0].reason, "cleared")

    const secondOutput = await runGoalCommand(hooks, sessionID, "ship second release")
    await hooks["chat.message"](
      { sessionID, messageID: "second-command", agent: "build" },
      { message: { id: "second-command" }, parts: secondOutput.parts },
    )
    const second = await store.load(sessionID)
    assert.equal(second.status, "active")

    const historyOutput = await runGoalCommand(hooks, sessionID, "history")
    assert.match(historyOutput.parts[0].text, /Archived goals \(newest first\)/)
    assert.match(historyOutput.parts[0].text, new RegExp(first.id.slice(0, 12)))
    assert.match(historyOutput.parts[0].text, /cleared/)
    assert.match(historyOutput.parts[0].text, /ship first release/)

    await hooks["chat.message"](
      { sessionID, messageID: "history-command", agent: "build" },
      { message: { id: "history-command" }, parts: historyOutput.parts },
    )
    assert.equal((await store.load(sessionID)).status, "active", "history command must remain command-owned")
    assert.equal((await store.load(sessionID)).id, second.id)

    const detailOutput = await runGoalCommand(hooks, sessionID, `history ${first.id.slice(0, 12)}`)
    assert.match(detailOutput.parts[0].text, new RegExp(`Archived goal: ${first.id}`))
    assert.match(detailOutput.parts[0].text, /Archive reason: cleared/)
    assert.match(detailOutput.parts[0].text, /Goal: ship first release/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
