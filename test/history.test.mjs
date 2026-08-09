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

async function bindCommandMessage(hooks, sessionID, messageID, output) {
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build" },
    { message: { id: messageID }, parts: output.parts },
  )
}

test("cleared goal remains inspectable and history lookup does not pause the current goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-history-"))
  try {
    const sessionID = "history-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const firstOutput = await runGoalCommand(hooks, sessionID, "ship first release")
    await bindCommandMessage(hooks, sessionID, "first-command", firstOutput)
    const first = await store.load(sessionID)
    assert.equal(first.status, "active")

    const clearOutput = await runGoalCommand(hooks, sessionID, "clear")
    await bindCommandMessage(hooks, sessionID, "clear-command", clearOutput)
    assert.equal(await store.load(sessionID), null)
    const archived = await store.history(sessionID)
    assert.equal(archived.length, 1)
    assert.equal(archived[0].goal.id, first.id)
    assert.equal(archived[0].reason, "cleared")

    const secondOutput = await runGoalCommand(hooks, sessionID, "ship second release")
    await bindCommandMessage(hooks, sessionID, "second-command", secondOutput)
    const second = await store.load(sessionID)
    assert.equal(second.status, "active")

    const historyOutput = await runGoalCommand(hooks, sessionID, "history")
    assert.match(historyOutput.parts[0].text, /Archived goals \(newest first\)/)
    assert.match(historyOutput.parts[0].text, new RegExp(first.id.slice(0, 12)))
    assert.match(historyOutput.parts[0].text, /cleared/)
    assert.match(historyOutput.parts[0].text, /ship first release/)

    await bindCommandMessage(hooks, sessionID, "history-command", historyOutput)
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

test("history prune keeps newest archives and cannot pause or replace the live goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-history-prune-command-"))
  try {
    const sessionID = "history-prune-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const firstOutput = await runGoalCommand(hooks, sessionID, "first archived objective")
    await bindCommandMessage(hooks, sessionID, "first-create", firstOutput)
    const first = await store.load(sessionID)
    const firstClear = await runGoalCommand(hooks, sessionID, "clear")
    await bindCommandMessage(hooks, sessionID, "first-clear", firstClear)

    const secondOutput = await runGoalCommand(hooks, sessionID, "second archived objective")
    await bindCommandMessage(hooks, sessionID, "second-create", secondOutput)
    const second = await store.load(sessionID)
    const secondClear = await runGoalCommand(hooks, sessionID, "clear")
    await bindCommandMessage(hooks, sessionID, "second-clear", secondClear)

    const liveOutput = await runGoalCommand(hooks, sessionID, "live objective")
    await bindCommandMessage(hooks, sessionID, "live-create", liveOutput)
    const live = await store.load(sessionID)
    assert.equal(live.status, "active")
    assert.deepEqual((await store.history(sessionID)).map((item) => item.goal.id), [second.id, first.id])

    const pruneOutput = await runGoalCommand(hooks, sessionID, "history prune --keep 1")
    assert.match(pruneOutput.parts[0].text, /kept 1 newest archived Goal\(s\); removed 1 older archive\(s\)/)
    assert.match(pruneOutput.parts[0].text, new RegExp(first.id.slice(0, 12)))
    await bindCommandMessage(hooks, sessionID, "prune-command", pruneOutput)

    const unchanged = await store.load(sessionID)
    assert.equal(unchanged.id, live.id)
    assert.equal(unchanged.status, "active", "history prune must remain command-owned")
    assert.deepEqual((await store.history(sessionID)).map((item) => item.goal.id), [second.id])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cleared unfinished goal restores paused and only resumes after explicit command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-restore-"))
  try {
    const sessionID = "restore-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const createOutput = await runGoalCommand(hooks, sessionID, 'recover deploy --check "npm test"')
    await bindCommandMessage(hooks, sessionID, "create-command", createOutput)
    const original = await store.load(sessionID)
    assert.equal(original.status, "active")

    const clearOutput = await runGoalCommand(hooks, sessionID, "clear")
    await bindCommandMessage(hooks, sessionID, "clear-command", clearOutput)
    assert.equal(await store.load(sessionID), null)

    const restoreOutput = await runGoalCommand(hooks, sessionID, `restore ${original.id.slice(0, 12)}`)
    assert.match(restoreOutput.parts[0].text, new RegExp(`Restored archived goal ${original.id} as paused`))
    assert.match(restoreOutput.parts[0].text, /Use \/goal resume to continue/)

    const restored = await store.load(sessionID)
    assert.equal(restored.id, original.id)
    assert.equal(restored.objective, original.objective)
    assert.equal(restored.revision, original.revision)
    assert.equal(restored.status, "paused")
    assert.match(restored.stopReason, /Restored from goal history/)
    assert.deepEqual(restored.requirements, original.requirements)
    assert.deepEqual(restored.usage, original.usage)
    assert.deepEqual(restored.execution, original.execution)
    assert.equal((await store.history(sessionID))[0].goal.id, original.id, "restore keeps the archive snapshot available")

    await bindCommandMessage(hooks, sessionID, "restore-command", restoreOutput)
    assert.equal((await store.load(sessionID)).status, "paused", "restore response itself must not resume work")

    const resumeOutput = await runGoalCommand(hooks, sessionID, "resume")
    assert.match(resumeOutput.parts[0].text, /Continue working toward the active OpenCode goal/)
    await bindCommandMessage(hooks, sessionID, "resume-command", resumeOutput)
    assert.equal((await store.load(sessionID)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("restore cannot overwrite a different unfinished live goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-restore-live-"))
  try {
    const sessionID = "restore-live-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const firstOutput = await runGoalCommand(hooks, sessionID, "first objective")
    await bindCommandMessage(hooks, sessionID, "first-command", firstOutput)
    const first = await store.load(sessionID)
    const clearOutput = await runGoalCommand(hooks, sessionID, "clear")
    await bindCommandMessage(hooks, sessionID, "clear-command", clearOutput)

    const secondOutput = await runGoalCommand(hooks, sessionID, "second objective")
    await bindCommandMessage(hooks, sessionID, "second-command", secondOutput)
    const second = await store.load(sessionID)
    assert.notEqual(second.id, first.id)

    const restoreOutput = await runGoalCommand(hooks, sessionID, `restore ${first.id.slice(0, 12)}`)
    assert.match(restoreOutput.parts[0].text, /Cannot restore while an unfinished Goal is current/)
    const unchanged = await store.load(sessionID)
    assert.equal(unchanged.id, second.id)
    assert.equal(unchanged.status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
