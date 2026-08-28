import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import { compactionContext, continuationPrompt } from "../dist/opencode/prompt.js"
import {
  formatTodoManifest,
  observeTodoPlan,
  summarizeTodoPlan,
  todoManifestIsCurrent,
  todoPlanIsCurrent,
  validGoalTodoPlan,
} from "../dist/runtime/todo-plan.js"
import { auditCompletion } from "../dist/verification/audit.js"

function makeTodos(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    id: `native-${index + 1}`,
    content: `Task ${String(index + 1).padStart(3, "0")}: preserve this exact durable work-plan item across restart and compaction`,
    status: index === 0 ? "in_progress" : "pending",
    priority: index < 10 ? "high" : "medium",
  }))
}

test("Goal persists a stable revision-bound item manifest for large native Todo plans", () => {
  const goal = createGoal({ sessionID: "durable-todo-100", objective: "finish a 100-step implementation plan", now: 100 })
  const todos = makeTodos()
  const observed = observeTodoPlan(goal, todos, 200)

  assert.equal(todoPlanIsCurrent(observed), true)
  assert.equal(todoManifestIsCurrent(observed), true)
  assert.equal(observed.todoPlan?.items?.length, 100)
  assert.equal(observed.todoPlan?.items?.[0]?.content, todos[0].content)
  assert.equal(observed.todoPlan?.items?.[0]?.nativeID, "native-1")
  assert.equal(observed.todoPlan?.items?.[99]?.order, 99)
  assert.equal(new Set(observed.todoPlan?.items?.map((item) => item.key)).size, 100)
  assert.deepEqual(observed.evidence, [], "Todo manifest must remain non-evidentiary")
  assert.equal(observed.progressRevision, 0, "Todo manifest persistence must not manufacture host progress")

  const firstKey = observed.todoPlan.items[0].key
  const statusUpdate = todos.map((item, index) => index === 0
    ? { ...item, status: "completed" }
    : index === 1 ? { ...item, status: "in_progress" } : item)
  const updated = observeTodoPlan(observed, statusUpdate, 300)
  assert.equal(updated.todoPlan.items[0].key, firstKey, "Goal-owned item identity must survive status changes")
  assert.equal(updated.todoPlan.items[0].status, "completed")
  assert.equal(updated.todoPlan.items[1].status, "in_progress")
})

test("legacy aggregate Todo telemetry upgrades to a durable manifest without a schema bump", () => {
  const goal = createGoal({ sessionID: "durable-todo-upgrade", objective: "ship", now: 100 })
  const todos = makeTodos(3)
  const modern = summarizeTodoPlan(goal.revision, todos, 200)
  const { items: _items, ...legacy } = modern
  const stored = { ...goal, todoPlan: legacy }

  assert.equal(validGoalTodoPlan(stored.todoPlan), true, "older schema-v1 aggregate telemetry remains valid")
  assert.equal(todoManifestIsCurrent(stored), false)

  const upgraded = observeTodoPlan(stored, todos, 300)
  assert.equal(upgraded.todoPlan.items.length, 3)
  assert.equal(todoManifestIsCurrent(upgraded), true)
})

test("Goal edit keeps the old item manifest stale until native planning genuinely changes", () => {
  const goal = createGoal({ sessionID: "durable-todo-revision", objective: "finish the project", now: 100 })
  const todos = makeTodos(4)
  const observed = observeTodoPlan(goal, todos, 200)
  const edited = editGoal(observed, { objective: "finish the project without API changes", now: 300 })

  assert.equal(todoPlanIsCurrent(edited), false)
  assert.equal(edited.todoPlan.goalRevision, 1)
  assert.equal(edited.todoPlan.items.length, 4)

  const unchangedReplay = observeTodoPlan(edited, todos, 400)
  assert.strictEqual(unchangedReplay, edited, "unchanged native replay must not silently rebind a stale manifest")

  const rebuiltTodos = [...todos, {
    id: "native-5",
    content: "Task 005: verify the new no-API-change constraint",
    status: "pending",
    priority: "high",
  }]
  const rebound = observeTodoPlan(edited, rebuiltTodos, 500)
  assert.equal(todoManifestIsCurrent(rebound), true)
  assert.equal(rebound.todoPlan.goalRevision, 2)
  assert.equal(rebound.todoPlan.items.length, 5)
})

test("compaction receives bounded recovery detail while ordinary continuation stays compact", () => {
  const goal = createGoal({ sessionID: "durable-todo-context", objective: "finish a broad plan", now: 100 })
  const verboseTodos = Array.from({ length: 100 }, (_, index) => ({
    id: `native-${index}`,
    content: `Recovery item ${index}: ${"x".repeat(180)}`,
    status: index === 0 ? "in_progress" : "pending",
    priority: "high",
  }))
  const observed = observeTodoPlan(goal, verboseTodos, 200)
  const compacted = compactionContext(observed)
  assert.match(compacted, /Todo manifest current r1; 100 items/)
  assert.match(compacted, /Recovery item 0:/)
  assert.match(compacted, /more item\(s\) retained durably in Goal state; omitted here to bound model context/)
  assert.ok(compacted.length < 20_000, "Todo recovery context must remain bounded even for verbose 100-item plans")

  const later = {
    ...observed,
    usage: { ...observed.usage, turns: 2 },
  }
  const reminder = continuationPrompt(later)
  assert.match(reminder, /durable Goal Todo manifest is recovery context, not a second planner or proof source/)
  assert.doesNotMatch(reminder, /Recovery item 0:/, "repeated continuation must not re-append the item manifest")
})

test("manifest corruption fails advisory validation and Todo completion remains non-evidentiary", () => {
  const goal = createGoal({ sessionID: "durable-todo-validation", objective: "ship", now: 100 })
  const completed = observeTodoPlan(goal, [
    { id: "a", content: "Do the work", status: "completed" },
    { id: "b", content: "Verify the work", status: "completed" },
  ], 200)

  const rendered = formatTodoManifest(completed)
  assert.match(rendered, /1\. \[completed\] Do the work/)
  assert.deepEqual(completed.evidence, [])
  assert.equal(auditCompletion(completed).ok, false, "a fully completed Todo manifest must not prove Goal completion")

  const corrupt = {
    ...completed.todoPlan,
    items: completed.todoPlan.items.map((item, index) => index === 1 ? { ...item, key: completed.todoPlan.items[0].key } : item),
  }
  assert.equal(validGoalTodoPlan(corrupt), false, "duplicate Goal-owned manifest keys are invalid advisory telemetry")
})
