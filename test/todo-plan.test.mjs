import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import {
  formatTodoPlan,
  normalizeNativeTodos,
  observeTodoPlan,
  summarizeTodoPlan,
  todoPlanIsCurrent,
  validGoalTodoPlan,
} from "../dist/runtime/todo-plan.js"

const todos = [
  { id: "a", content: "Inspect the repository", status: "completed", priority: "high" },
  { id: "b", content: "Fix the required gaps", status: "in_progress", priority: "high" },
  { id: "c", content: "Run the acceptance tests", status: "pending", priority: "medium" },
  { id: "d", content: "Unrelated cleanup", status: "cancelled", priority: "low" },
]

test("native Todo telemetry is advisory, deterministic, and revision-bound", () => {
  const goal = createGoal({ sessionID: "todo-plan", objective: "analyze the project and finish required gaps", now: 100 })
  const normalized = normalizeNativeTodos(todos)
  assert.ok(normalized)

  const summary = summarizeTodoPlan(goal.revision, normalized, 200)
  assert.equal(summary.total, 4)
  assert.equal(summary.pending, 1)
  assert.equal(summary.inProgress, 1)
  assert.equal(summary.completed, 1)
  assert.equal(summary.cancelled, 1)
  assert.match(summary.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(validGoalTodoPlan(summary), true)

  const observed = observeTodoPlan(goal, normalized, 200)
  assert.equal(todoPlanIsCurrent(observed), true)
  assert.equal(observed.progressRevision, 0, "Todo planning must not count as host-observed work progress")
  assert.deepEqual(observed.evidence, [], "Todo planning must not create completion evidence")
  assert.match(formatTodoPlan(observed), /current r1; 4 total/)

  const duplicate = observeTodoPlan(observed, normalized, 999)
  assert.strictEqual(duplicate, observed, "rewriting the same Todo list should not cause Goal storage churn")

  const edited = editGoal(observed, { objective: "analyze the project and finish required gaps without API changes", now: 300 })
  assert.equal(edited.revision, 2)
  assert.equal(edited.todoPlan?.goalRevision, 1, "the previous plan stays visible only as stale telemetry")
  assert.equal(todoPlanIsCurrent(edited), false)
  assert.match(formatTodoPlan(edited), /STALE r1/)
})

test("malformed native Todo input and malformed advisory telemetry are ignored safely", () => {
  assert.equal(normalizeNativeTodos([{ content: "bad", status: "mystery" }]), null)
  assert.equal(normalizeNativeTodos([{ content: "", status: "pending" }]), null)

  const goal = createGoal({ sessionID: "bad-telemetry", objective: "ship", now: 100 })
  const corrupt = { ...goal, todoPlan: { goalRevision: "one" } }
  assert.equal(validGoalTodoPlan(corrupt.todoPlan), false)
  assert.equal(todoPlanIsCurrent(corrupt), false)
  assert.equal(formatTodoPlan(corrupt), "invalid advisory telemetry ignored")
})
