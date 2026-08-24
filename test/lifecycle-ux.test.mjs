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

function pausedChatGuidance(fake) {
  return fake.toasts.filter((item) =>
    item?.body?.variant === "warning"
      && /Goal remains paused/.test(item?.body?.message ?? ""),
  )
}

function naturalResumeToasts(fake) {
  return fake.toasts.filter((item) =>
    item?.body?.variant === "success"
      && /resumed from your continuation message/.test(item?.body?.message ?? ""),
  )
}

async function command(hooks, argumentsText, sessionID = "session-ux") {
  const output = { parts: [{ type: "text", text: argumentsText }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: argumentsText }, output)
  return output
}

async function bindCommandChat(hooks, output, messageID, sessionID = "session-ux") {
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build" },
    { message: { id: messageID }, parts: output.parts },
  )
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

test("paused Goal create-conflict and pause output explain both explicit and natural resume", async () => {
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
    assert.match(paused.parts[0].text, /short explicit continuation message/)

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

test("ordinary foreground chat re-enters an automatically paused Goal while Goal commands remain read-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-paused-chat-ux-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    const reason = "Paused after 3 continuation turns without host-observed progress."

    await command(hooks, "keep researching until the canonical dataset is complete")
    let goal = await store.load("session-ux")
    assert.ok(goal)
    await store.save(pauseGoal(goal, reason))
    fake.toasts.length = 0

    const question = await foregroundChat(hooks, "what happened here?", "human-1")
    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.stalledTurns, 0)
    assert.equal(question.parts[0].text, "what happened here?", "foreground text must stay intact for the model")
    assert.ok(fake.toasts.some((item) => item?.body?.variant === "success" && /foreground message/.test(item?.body?.message ?? "")))
    assert.equal(pausedChatGuidance(fake).length, 0)

    goal = await store.load("session-ux")
    assert.ok(goal)
    await store.save(pauseGoal(goal, reason))
    fake.toasts.length = 0

    const status = await command(hooks, "status")
    await bindCommandChat(hooks, status, "status-owned")
    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused")
    assert.equal(persisted.stopReason, reason)
    assert.equal(pausedChatGuidance(fake).length, 0, "read-only Goal commands must not be mistaken for foreground re-entry")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("short continuation chat resumes an automatically paused Goal through the normal resume chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-natural-resume-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    const reason = "Paused after 3 continuation turns without host-observed progress."

    await command(hooks, "keep researching until the canonical dataset is complete")
    let goal = await store.load("session-ux")
    assert.ok(goal)
    await store.save(pauseGoal(goal, reason))
    fake.toasts.length = 0

    const turkish = await foregroundChat(hooks, "devam et", "human-resume-tr")
    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.stalledTurns, 0)
    assert.match(turkish.parts[0].text, /Continue working toward the active OpenCode goal/)
    assert.equal(naturalResumeToasts(fake).length, 1)
    assert.equal(pausedChatGuidance(fake).length, 0)

    goal = await store.load("session-ux")
    assert.ok(goal)
    await store.save(pauseGoal(goal, reason))

    const english = await foregroundChat(hooks, "Continue!", "human-resume-en")
    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.match(english.parts[0].text, /Continue working toward the active OpenCode goal/)
    assert.equal(naturalResumeToasts(fake).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
