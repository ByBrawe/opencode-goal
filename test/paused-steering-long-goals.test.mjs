import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, { createGoal, editGoal, pauseGoal } from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"
import { closeObservedTurn } from "../dist/runtime/progress.js"
import { observeTodoPlan } from "../dist/runtime/todo-plan.js"

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

async function command(hooks, argumentsText, sessionID = "session-long") {
  const output = { parts: [{ type: "text", text: argumentsText }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: argumentsText }, output)
  return output
}

async function foregroundChat(hooks, text, messageID, sessionID = "session-long") {
  const output = { message: { id: messageID }, parts: [{ type: "text", text }] }
  await hooks["chat.message"]({ sessionID, messageID, agent: "build" }, output)
  return output
}

test("actionable foreground instruction resumes an auto-stalled Goal without rewriting the instruction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-auto-stall-steering-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    const reason = "Paused after 3 continuation turns without host-observed progress."

    await command(hooks, "finish the project")
    const active = await store.load("session-long")
    assert.ok(active)
    await store.save(pauseGoal(active, reason))

    const output = await foregroundChat(hooks, "önce 12. haritayı düzelt", "human-steer")
    const persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.stalledTurns, 0)
    assert.equal(output.parts[0].text, "önce 12. haritayı düzelt", "the human steering instruction must remain intact")
    assert.ok(fake.toasts.some((item) => /new work instruction/.test(item?.body?.message ?? "")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("explicit user pause is not silently resumed by an unrelated work instruction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-explicit-pause-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })

    await command(hooks, "finish the project")
    await command(hooks, "pause")
    await foregroundChat(hooks, "şimdi başka dosyayı düzelt", "human-after-pause")

    const persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused")
    assert.equal(persisted.stopReason, "paused by user")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("open long Todo plans receive a bounded adaptive no-progress window", () => {
  let goal = createGoal({ sessionID: "long-plan", objective: "finish one hundred concrete tasks" })
  goal = observeTodoPlan(goal, Array.from({ length: 100 }, (_, index) => ({
    content: `Task ${index + 1}`,
    status: index === 0 ? "in_progress" : "pending",
  })))

  for (let turn = 0; turn < 11; turn += 1) goal = closeObservedTurn(goal)
  assert.equal(goal.status, "active")
  assert.equal(goal.stalledTurns, 11)
  goal = closeObservedTurn(goal)
  assert.equal(goal.status, "paused")
  assert.equal(goal.stalledTurns, 12)
})

test("Goal edit invalidates previous Todo telemetry until a fresh native plan is observed", () => {
  let goal = createGoal({ sessionID: "todo-revision", objective: "old contract" })
  goal = observeTodoPlan(goal, [{ content: "Old task", status: "pending" }])
  assert.ok(goal.todoPlan)

  const edited = editGoal(goal, { objective: "new contract" })
  assert.equal(edited.revision, 2)
  assert.equal(edited.todoPlan, undefined)
})
