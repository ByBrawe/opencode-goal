import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import { auditCompletion } from "../dist/verification/audit.js"
import {
  formatTodoManifest,
  formatTodoPlan,
  observeTodoPlan,
  validGoalTodoPlan,
} from "../dist/runtime/todo-plan.js"

test("multiple native Todos in_progress are persisted as an advisory drift warning", () => {
  const goal = createGoal({ sessionID: "todo-multi-progress", objective: "finish the plan", now: 100 })
  const observed = observeTodoPlan(goal, [
    { id: "a", content: "Implement A", status: "in_progress" },
    { id: "b", content: "Implement B", status: "in_progress" },
    { id: "c", content: "Verify", status: "pending" },
  ], 200)

  assert.equal(observed.todoPlan?.anomalies?.[0]?.kind, "multiple_in_progress")
  assert.equal(observed.todoPlan?.anomalies?.[0]?.itemKeys.length, 2)
  assert.match(formatTodoPlan(observed), /WARNING 2 native Todo items are simultaneously in_progress/)
  assert.match(formatTodoManifest(observed), /Todo drift WARNING:/)
  assert.deepEqual(observed.evidence, [], "Todo drift warnings must never manufacture Goal evidence")

  const audit = auditCompletion(observed)
  assert.equal(audit.ok, false)
  assert.ok(audit.reasons.some((reason) => reason.includes("2 in progress")))
})

test("completed Todo regression is surfaced and remains stable across unchanged replay", () => {
  const goal = createGoal({ sessionID: "todo-completed-regression", objective: "finish without losing completed work", now: 100 })
  const initial = observeTodoPlan(goal, [
    { id: "a", content: "Inspect repository", status: "completed" },
    { id: "b", content: "Implement fix", status: "completed" },
    { id: "c", content: "Run verification", status: "pending" },
  ], 200)

  const regressedTodos = [
    { id: "a", content: "Inspect repository", status: "pending" },
    { id: "b", content: "Implement fix", status: "in_progress" },
    { id: "c", content: "Run verification", status: "pending" },
  ]
  const regressed = observeTodoPlan(initial, regressedTodos, 300)
  const anomaly = regressed.todoPlan?.anomalies?.find((item) => item.kind === "completed_regression")
  assert.ok(anomaly)
  assert.equal(anomaly.itemKeys.length, 2)
  assert.match(anomaly.summary, /2 previously completed Todo item\(s\) regressed/)

  const replay = observeTodoPlan(regressed, regressedTodos, 999)
  assert.strictEqual(replay, regressed, "unchanged anomalous replay must not create storage churn or clear the warning")

  const repaired = observeTodoPlan(regressed, [
    { id: "a", content: "Inspect repository", status: "completed" },
    { id: "b", content: "Implement fix", status: "completed" },
    { id: "c", content: "Run verification", status: "in_progress" },
  ], 400)
  assert.equal(repaired.todoPlan?.anomalies?.some((item) => item.kind === "completed_regression"), false)
})

test("substantial same-revision Todo replacement is surfaced without becoming a second planner", () => {
  const goal = createGoal({ sessionID: "todo-plan-replacement", objective: "finish the current plan", now: 100 })
  const first = observeTodoPlan(goal, [
    { content: "Task A", status: "completed" },
    { content: "Task B", status: "completed" },
    { content: "Task C", status: "pending" },
    { content: "Task D", status: "pending" },
  ], 200)

  const replaced = observeTodoPlan(first, [
    { content: "New task W", status: "in_progress" },
    { content: "New task X", status: "pending" },
    { content: "New task Y", status: "pending" },
    { content: "New task Z", status: "pending" },
  ], 300)

  const anomaly = replaced.todoPlan?.anomalies?.find((item) => item.kind === "substantial_replacement")
  assert.ok(anomaly)
  assert.match(anomaly.summary, /4 removed, 4 added, 0 retained/)
  assert.deepEqual(replaced.evidence, [])
  assert.equal(replaced.progressRevision, 0, "plan replacement warning is not host-observed project progress")
})

test("Goal revision changes allow a genuine Todo rebuild without same-revision drift warnings", () => {
  let goal = createGoal({ sessionID: "todo-rebuild-after-edit", objective: "finish original scope", now: 100 })
  goal = observeTodoPlan(goal, [
    { content: "Old A", status: "completed" },
    { content: "Old B", status: "completed" },
    { content: "Old C", status: "pending" },
    { content: "Old D", status: "pending" },
  ], 200)
  goal = editGoal(goal, { objective: "finish revised scope", now: 300 })

  const rebuilt = observeTodoPlan(goal, [
    { content: "New A", status: "in_progress" },
    { content: "New B", status: "pending" },
    { content: "New C", status: "pending" },
    { content: "New D", status: "pending" },
  ], 400)

  assert.equal(rebuilt.todoPlan?.goalRevision, 2)
  assert.equal(rebuilt.todoPlan?.anomalies?.some((item) => item.kind === "completed_regression"), false)
  assert.equal(rebuilt.todoPlan?.anomalies?.some((item) => item.kind === "substantial_replacement"), false)
})

test("malformed persisted Todo anomaly metadata invalidates advisory telemetry", () => {
  const goal = createGoal({ sessionID: "todo-invalid-anomaly", objective: "ship", now: 100 })
  const observed = observeTodoPlan(goal, [
    { content: "A", status: "in_progress" },
    { content: "B", status: "in_progress" },
  ], 200)
  assert.equal(validGoalTodoPlan(observed.todoPlan), true)

  const corrupt = {
    ...observed.todoPlan,
    anomalies: [{ kind: "completed_regression", summary: "", itemKeys: ["x"] }],
  }
  assert.equal(validGoalTodoPlan(corrupt), false)
})
