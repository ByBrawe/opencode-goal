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
  const prompts = []
  return {
    client: {
      session: {
        prompt(arg) {
          prompts.push(arg)
          return Promise.resolve({})
        },
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
    prompts,
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
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

test("paused Goal UX explains explicit command resume and model-decided natural-language resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-pause-ux-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })

    await command(hooks, "keep this target")
    const paused = await command(hooks, "pause")
    assert.equal(paused.noReply, true)
    assert.match(paused.parts[0].text, /Goal paused\. Autonomous Goal continuation is now off\./)
    assert.match(paused.parts[0].text, /\/goal resume/)
    assert.match(paused.parts[0].text, /normal language/)
    assert.match(paused.parts[0].text, /interpreted by the model/)

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

test("ordinary foreground chat does not directly reactivate an automatically paused Goal", async () => {
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

    const question = await foregroundChat(hooks, "what happened here?", "human-1")
    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused")
    assert.equal(persisted.stopReason, reason)
    assert.equal(question.parts[0].text, "what happened here?", "foreground text must stay intact for model intent handling")

    const status = await command(hooks, "status")
    await bindCommandChat(hooks, status, "status-owned")
    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused")
    assert.equal(persisted.stopReason, reason)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("natural-language continuation is model-controlled and activates at the idle ownership boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-natural-resume-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    const reason = "Paused after 3 continuation turns without host-observed progress."

    await command(hooks, "keep researching until the canonical dataset is complete")
    const active = await store.load("session-ux")
    assert.ok(active)
    await store.save(pauseGoal(active, reason))

    const turkish = await foregroundChat(hooks, "devam et", "human-resume-tr")
    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused", "plain chat must not bypass the model and directly resume")
    assert.equal(turkish.parts[0].text, "devam et")

    const result = await hooks.tool.opencode_goal_resume.execute({}, {
      sessionID: "session-ux",
      messageID: "assistant-routing",
      agent: "build",
    })
    assert.match(String(result), /Goal resume accepted from the user's natural-language intent/)

    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused", "tool routing turn must remain outside Goal ownership")
    assert.equal(persisted.skipNextStallCheck, undefined)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-ux" } } })
    await tick()
    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.stalledTurns, 0)
    assert.equal(persisted.skipNextStallCheck, undefined)
    assert.equal(fake.prompts.length, 1)
    assert.match(fake.prompts[0].body.parts[0].text, /Continue working toward the active OpenCode goal/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
