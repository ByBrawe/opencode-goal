import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, { createGoal, editGoal, pauseGoal } from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"
import { accountAssistantUsage } from "../dist/runtime/accounting.js"
import { closeObservedTurn } from "../dist/runtime/progress.js"
import { observeTodoPlan, todoPlanIsCurrent } from "../dist/runtime/todo-plan.js"

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

test("new Goals have no implicit cumulative turn cap while explicit caps remain hard guards", () => {
  let unlimited = createGoal({ sessionID: "turn-budget-default", objective: "finish a long plan" })
  assert.equal(unlimited.budget.maxTurns, 0)
  for (let turn = 1; turn <= 40; turn += 1) {
    unlimited = accountAssistantUsage(unlimited, { messageID: `m-${turn}` })
    unlimited = closeObservedTurn(unlimited, { maxStalledTurns: 100 })
  }
  assert.equal(unlimited.status, "active")
  assert.equal(unlimited.usage.turns, 40)

  let bounded = createGoal({ sessionID: "turn-budget-explicit", objective: "bounded work", budget: { maxTurns: 2 } })
  bounded = accountAssistantUsage(bounded, { messageID: "b-1" })
  bounded = closeObservedTurn(bounded, { maxStalledTurns: 100 })
  bounded = accountAssistantUsage(bounded, { messageID: "b-2" })
  bounded = closeObservedTurn(bounded, { maxStalledTurns: 100 })
  assert.equal(bounded.status, "budget_limited")
  assert.match(bounded.stopReason ?? "", /turns 2 \/ 2/)
})

test("Goal edit keeps stale Todo telemetry and rejects unchanged re-observation", () => {
  let goal = createGoal({ sessionID: "todo-revision", objective: "old contract" })
  const oldTodos = [{ content: "Old task", status: "pending" }]
  goal = observeTodoPlan(goal, oldTodos)
  assert.ok(goal.todoPlan)

  const edited = editGoal(goal, { objective: "new contract" })
  assert.equal(edited.revision, 2)
  assert.equal(edited.todoPlan?.goalRevision, 1)
  assert.equal(todoPlanIsCurrent(edited), false)

  const unchanged = observeTodoPlan(edited, oldTodos)
  assert.strictEqual(unchanged, edited, "the old native Todo list must not become current merely by being emitted again")
  assert.equal(unchanged.todoPlan?.goalRevision, 1)

  const rebuilt = observeTodoPlan(edited, [{ content: "New contract task", status: "pending" }])
  assert.equal(rebuilt.todoPlan?.goalRevision, 2)
  assert.equal(todoPlanIsCurrent(rebuilt), true)
})
