import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { observeTodoPlan, todoPlanIsCurrent } from "../dist/runtime/todo-plan.js"

const initialTodos = [
  { id: "inspect", content: "Inspect the repository", status: "completed", priority: "high" },
  { id: "fix", content: "Fix required gaps", status: "in_progress", priority: "high" },
  { id: "verify", content: "Run acceptance tests", status: "pending", priority: "medium" },
]

const changedTodos = [
  { id: "inspect", content: "Inspect the repository", status: "completed", priority: "high" },
  { id: "fix", content: "Fix required gaps", status: "completed", priority: "high" },
  { id: "verify", content: "Run acceptance tests", status: "in_progress", priority: "medium" },
]

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
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: argumentsText }, output)
  return output
}

async function bindCommandMessage(hooks, sessionID, messageID, output, agent = "build") {
  await hooks["chat.message"](
    { sessionID, messageID, agent },
    { message: { id: messageID }, parts: output.parts },
  )
}

async function activateAssistant(hooks, sessionID, userMessageID, assistantMessageID) {
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          role: "assistant",
          parentID: userMessageID,
          time: { created: Date.now() },
        },
      },
    },
  })
}

async function todoCall(hooks, sessionID, callID, todos) {
  const event = { tool: "todowrite", sessionID, callID, args: { todos } }
  await hooks["tool.execute.before"](event)
  await hooks["tool.execute.after"](event, { metadata: { todos } })
}

test("native Todo writes bind to the active Goal revision without becoming progress or evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-todo-bridge-"))
  try {
    const sessionID = "todo-bridge-session"
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const store = new GoalStore(root)

    const created = await runGoalCommand(hooks, sessionID, "analyze this project and finish required gaps")
    await bindCommandMessage(hooks, sessionID, "goal-user-r1", created)

    await todoCall(hooks, sessionID, "todo-unowned", initialTodos)
    let current = await store.load(sessionID)
    assert.ok(current)
    assert.equal(current.todoPlan, undefined, "todowrite outside an owned assistant Goal turn must not bind planning telemetry")

    await activateAssistant(hooks, sessionID, "goal-user-r1", "goal-assistant-r1")
    await todoCall(hooks, sessionID, "todo-1", initialTodos)
    current = await store.load(sessionID)
    assert.equal(todoPlanIsCurrent(current), true)
    assert.deepEqual(
      {
        total: current.todoPlan.total,
        pending: current.todoPlan.pending,
        inProgress: current.todoPlan.inProgress,
        completed: current.todoPlan.completed,
      },
      { total: 3, pending: 1, inProgress: 1, completed: 1 },
    )
    assert.equal(current.progressRevision, 0, "Todo planning must not count as host-observed progress")
    assert.deepEqual(current.evidence, [], "Todo planning must not create completion evidence")

    const generationAfterFirstPlan = current.storageGeneration
    await todoCall(hooks, sessionID, "todo-2", initialTodos)
    current = await store.load(sessionID)
    assert.equal(current.storageGeneration, generationAfterFirstPlan, "identical native Todo rewrites must not churn Goal storage")

    const staleEvent = { tool: "todowrite", sessionID, callID: "todo-stale-revision", args: { todos: changedTodos } }
    await hooks["tool.execute.before"](staleEvent)
    const editedOutput = await runGoalCommand(hooks, sessionID, "edit analyze this project and finish required gaps without changing the public API")
    await hooks["tool.execute.after"](staleEvent, { metadata: { todos: changedTodos } })

    current = await store.load(sessionID)
    assert.equal(current.revision, 2)
    assert.equal(current.todoPlan.goalRevision, 1, "an older assistant todowrite call must not bind itself to a newer Goal revision")
    assert.equal(todoPlanIsCurrent(current), false)

    await bindCommandMessage(hooks, sessionID, "goal-user-r2", editedOutput)
    await activateAssistant(hooks, sessionID, "goal-user-r2", "goal-assistant-r2")
    await todoCall(hooks, sessionID, "todo-current-r2", changedTodos)
    current = await store.load(sessionID)
    assert.equal(current.todoPlan.goalRevision, 2)
    assert.equal(todoPlanIsCurrent(current), true)
    const digestBeforePauseRace = current.todoPlan.digest

    const pauseEvent = { tool: "todowrite", sessionID, callID: "todo-pause-race", args: { todos: initialTodos } }
    await hooks["tool.execute.before"](pauseEvent)
    await runGoalCommand(hooks, sessionID, "pause")
    const generationAfterPause = (await store.load(sessionID)).storageGeneration
    await hooks["tool.execute.after"](pauseEvent, { metadata: { todos: initialTodos } })

    current = await store.load(sessionID)
    assert.equal(current.status, "paused")
    assert.equal(current.storageGeneration, generationAfterPause, "a todowrite finishing after pause must not mutate Goal storage")
    assert.equal(current.todoPlan.digest, digestBeforePauseRace)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("restoring an archived Goal clears stale native Todo binding telemetry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-todo-restore-"))
  try {
    const sessionID = "todo-restore-session"
    const store = new GoalStore(root)
    let goal = createGoal({ sessionID, objective: "finish the archived work", now: 100 })
    goal = observeTodoPlan(goal, initialTodos, 150)
    await store.save(goal)
    await store.clear(sessionID)
    assert.equal(await store.load(sessionID), null)

    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await runGoalCommand(hooks, sessionID, `restore ${goal.id.slice(0, 12)}`)

    const restored = await store.load(sessionID)
    assert.ok(restored)
    assert.equal(restored.id, goal.id)
    assert.equal(restored.status, "paused")
    assert.equal(restored.todoPlan, undefined, "session Todo state may have drifted while archived, so restore must require a fresh plan binding")
    assert.deepEqual(restored.evidence, goal.evidence, "clearing advisory Todo telemetry must not discard Goal evidence")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
