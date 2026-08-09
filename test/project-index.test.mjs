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

test("project Goal list exposes live snapshots across sessions without mutating either Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-project-index-"))
  try {
    const sessionA = "project-index-session-a"
    const sessionB = "project-index-session-b"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const createA = await runGoalCommand(hooks, sessionA, "ship API compatibility")
    await bindCommandMessage(hooks, sessionA, "create-a", createA)
    const createB = await runGoalCommand(hooks, sessionB, "refresh operator docs")
    await bindCommandMessage(hooks, sessionB, "create-b", createB)

    const beforeA = await store.load(sessionA)
    const beforeB = await store.load(sessionB)
    assert.equal(beforeA.status, "active")
    assert.equal(beforeB.status, "active")

    const list = await runGoalCommand(hooks, sessionA, "list")
    assert.match(list.parts[0].text, /Project Goal snapshots \(\* = current session\)/)
    assert.match(list.parts[0].text, new RegExp(`\\* ${beforeA.id.slice(0, 12)}`))
    assert.match(list.parts[0].text, /ship API compatibility/)
    assert.match(list.parts[0].text, new RegExp(` ${beforeB.id.slice(0, 12)}`))
    assert.match(list.parts[0].text, /refresh operator docs/)

    await bindCommandMessage(hooks, sessionA, "list-a", list)
    assert.deepEqual(await store.load(sessionA), beforeA, "project list must not pause or rewrite the current Goal")
    assert.deepEqual(await store.load(sessionB), beforeB, "project list must never mutate a foreign-session Goal")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("project Goal list can inspect another session by Goal id prefix without adopting it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-project-inspect-"))
  try {
    const ownerSession = "project-owner-session"
    const observerSession = "project-observer-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const create = await runGoalCommand(hooks, ownerSession, 'ship release --constraint "keep API compatible"')
    await bindCommandMessage(hooks, ownerSession, "owner-create", create)
    const owned = await store.load(ownerSession)
    assert.equal(owned.status, "active")

    const detail = await runGoalCommand(hooks, observerSession, `list ${owned.id.slice(0, 12)}`)
    assert.match(detail.parts[0].text, new RegExp(`Project Goal: ${owned.id}`))
    assert.match(detail.parts[0].text, new RegExp(`Session: ${ownerSession}`))
    assert.match(detail.parts[0].text, /Goal: ship release/)
    assert.match(detail.parts[0].text, /Status: active/)

    await bindCommandMessage(hooks, observerSession, "observer-list", detail)
    assert.deepEqual(await store.load(ownerSession), owned, "inspection from another session must not adopt, pause, or rewrite the Goal")
    assert.equal(await store.load(observerSession), null, "read-only inspection must not create a Goal in the observer session")

    const missing = await runGoalCommand(hooks, observerSession, "list deadbeef")
    assert.match(missing.parts[0].text, /No live project Goal matches "deadbeef"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
