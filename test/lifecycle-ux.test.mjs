import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, { pauseGoal } from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"

async function readOnlyGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function fakeClient() {
  const toasts = []
  return {
    client: {
      session: {
        prompt() { return Promise.resolve({}) },
        abort() { return Promise.resolve(true) },
      },
      tui: {
        showToast(arg) {
          toasts.push(arg)
          return Promise.resolve({})
        },
      },
    },
    toasts,
  }
}

async function command(hooks, argumentsText, sessionID = "session-ux") {
  const output = { parts: [{ type: "text", text: argumentsText }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: argumentsText }, output)
  return output
}

async function foregroundChat(hooks, text, messageID, sessionID = "session-ux") {
  const output = { message: { id: messageID }, parts: [{ type: "text", text }] }
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build" },
    output,
  )
  return output
}

test("creating a second live Goal shows actionable guidance instead of throwing or replacing state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-lifecycle-ux-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })

    const first = await command(hooks, "ship the first target")
    assert.match(first.parts[0].text, /Continue working toward the active OpenCode goal/)

    const second = await command(hooks, "replace me silently")
    assert.equal(second.noReply, true)
    assert.match(second.parts[0].text, /New Goal not created: this session already has an unfinished Goal\./)
    assert.match(second.parts[0].text, /Current Goal: ship the first target/)
    assert.match(second.parts[0].text, /\/goal status/)
    assert.match(second.parts[0].text, /\/goal edit <objective>/)
    assert.match(second.parts[0].text, /\/goal add <objective>/)
    assert.match(second.parts[0].text, /\/goal clear/)
    assert.match(second.parts[0].text, /No Goal state was changed/)

    const persisted = await readOnlyGoal(root)
    assert.equal(persisted.objective, "ship the first target")
    assert.equal(persisted.status, "active")
    assert.ok(fake.toasts.some((item) => item?.body?.variant === "warning" && /unfinished Goal/.test(item?.body?.message ?? "")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("paused Goal create-conflict and pause output tell the user to use /goal resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-pause-ux-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })

    await command(hooks, "keep this target")
    const paused = await command(hooks, "pause")
    assert.equal(paused.noReply, true)
    assert.match(paused.parts[0].text, /Goal paused\. Autonomous Goal continuation is now off\./)
    assert.match(paused.parts[0].text, /\/goal resume/)
    assert.match(paused.parts[0].text, /devam et/)
    assert.match(paused.parts[0].text, /normal foreground user message/)

    const conflict = await command(hooks, "start a different target")
    assert.equal(conflict.noReply, true)
    assert.match(conflict.parts[0].text, /Status: paused/)
    assert.match(conflict.parts[0].text, /\/goal resume — resume the current paused Goal\./)

    const persisted = await readOnlyGoal(root)
    assert.equal(persisted.objective, "keep this target")
    assert.equal(persisted.status, "paused")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("foreground chat on an automatically paused Goal warns once without silently resuming it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-paused-chat-ux-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    const reason = "Paused after 3 continuation turns without host-observed progress."

    await command(hooks, "keep researching until the canonical dataset is complete")
    const active = await store.load("session-ux")
    assert.ok(active)
    await store.save(pauseGoal(active, reason))
    fake.toasts.length = 0

    await foregroundChat(hooks, "devam et", "human-1")
    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused")
    assert.equal(persisted.stopReason, reason)

    let warnings = fake.toasts.filter((item) => item?.body?.variant === "warning" && /Goal remains paused/.test(item?.body?.message ?? ""))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].body.message, /\/goal resume/)

    await foregroundChat(hooks, "continue", "human-2")
    warnings = fake.toasts.filter((item) => item?.body?.variant === "warning" && /Goal remains paused/.test(item?.body?.message ?? ""))
    assert.equal(warnings.length, 1, "the same paused snapshot should not spam repeated foreground-chat warnings")

    const status = await command(hooks, "status")
    await hooks["chat.message"](
      { sessionID: "session-ux", messageID: "status-owned", agent: "build" },
      status,
    )
    warnings = fake.toasts.filter((item) => item?.body?.variant === "warning" && /Goal remains paused/.test(item?.body?.message ?? ""))
    assert.equal(warnings.length, 1, "read-only Goal commands must not be mistaken for foreground chat")

    await command(hooks, "resume")
    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")

    const resumed = await store.load("session-ux")
    assert.ok(resumed)
    await store.save(pauseGoal(resumed, reason))
    await foregroundChat(hooks, "devam et yine", "human-3")
    warnings = fake.toasts.filter((item) => item?.body?.variant === "warning" && /Goal remains paused/.test(item?.body?.message ?? ""))
    assert.equal(warnings.length, 2, "a new pause after explicit resume should be allowed to warn again")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
