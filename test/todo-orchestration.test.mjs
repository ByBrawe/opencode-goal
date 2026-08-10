import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal, editGoal, pauseGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { observeTodoPlan, todoPlanIsCurrent } from "../dist/runtime/todo-plan.js"
import { installGoalTodoOrchestration } from "../dist/opencode/todo-orchestration.js"

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

async function todoCall(hooks, sessionID, callID, todos) {
  const event = { tool: "todowrite", sessionID, callID, args: { todos } }
  await hooks["tool.execute.before"](event)
  await hooks["tool.execute.after"](event, { metadata: { todos } })
}

test("native Todo writes bind to the active Goal revision without becoming progress or evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-todo-bridge-"))
  try {
    const sessionID = "todo-bridge-session"
    const store = new GoalStore(root)
    await store.save(createGoal({ sessionID, objective: "analyze this project and finish required gaps", now: 100 }))

    const hooks = {
      "tool.execute.before": async () => {},
      "tool.execute.after": async () => {},
    }
    installGoalTodoOrchestration({ directory: root }, hooks)

    await todoCall(hooks, sessionID, "todo-1", initialTodos)
    let current = await store.load(sessionID)
    assert.ok(current)
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
    current = await store.load(sessionID)
    await store.save(editGoal(current, {
      objective: "analyze this project and finish required gaps without changing the public API",
      now: 300,
    }))
    await hooks["tool.execute.after"](staleEvent, { metadata: { todos: changedTodos } })

    current = await store.load(sessionID)
    assert.equal(current.revision, 2)
    assert.equal(current.todoPlan.goalRevision, 1, "an older todowrite call must not bind itself to a newer Goal revision")
    assert.equal(todoPlanIsCurrent(current), false)

    await todoCall(hooks, sessionID, "todo-current-r2", changedTodos)
    current = await store.load(sessionID)
    assert.equal(current.todoPlan.goalRevision, 2)
    assert.equal(todoPlanIsCurrent(current), true)
    const digestBeforePauseRace = current.todoPlan.digest

    const pauseEvent = { tool: "todowrite", sessionID, callID: "todo-pause-race", args: { todos: initialTodos } }
    await hooks["tool.execute.before"](pauseEvent)
    current = await store.load(sessionID)
    await store.save(pauseGoal(current, "test pause", 400))
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

    const hooks = {
      "command.execute.before": async (event) => {
        if (event.command !== "goal" || !String(event.arguments).startsWith("restore ")) return
        const selector = String(event.arguments).slice("restore ".length).trim()
        const result = await store.restore(event.sessionID, selector, 250)
        assert.equal(result.ok, true)
      },
      "tool.execute.before": async () => {},
      "tool.execute.after": async () => {},
    }
    installGoalTodoOrchestration({ directory: root }, hooks)

    await hooks["command.execute.before"](
      { command: "goal", sessionID, arguments: `restore ${goal.id.slice(0, 12)}` },
      { parts: [] },
    )

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
