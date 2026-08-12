import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

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
