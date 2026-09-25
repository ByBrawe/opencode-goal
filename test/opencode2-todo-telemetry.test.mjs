import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, editGoal, pauseGoal } from "../dist/domain/goal.js"
import { applyOpenCode2TodoUpdate, openCode2TodoUpdate } from "../dist/opencode2/todo-telemetry.js"

const TODOS = [
  { content: "Inspect repository", status: "in_progress", priority: "high" },
  { content: "Implement gap", status: "pending", priority: "high" },
  { content: "Run checks", status: "pending", priority: "medium" },
]

test("V2 todo.updated maps exact native Todo payload into V1 advisory telemetry", () => {
  const goal = createGoal({ sessionID: "todo-v2", objective: "finish work", now: 100 })
  const event = { type: "todo.updated", data: { sessionID: "todo-v2", todos: TODOS } }
  const update = openCode2TodoUpdate(event)
  assert.deepEqual(update, { sessionID: "todo-v2", todos: TODOS })

  const next = applyOpenCode2TodoUpdate(goal, event, 200)
  assert.equal(next.todoPlan.goalRevision, goal.revision)
  assert.equal(next.todoPlan.total, 3)
  assert.equal(next.todoPlan.inProgress, 1)
  assert.equal(next.todoPlan.pending, 2)
  assert.equal(next.progressRevision, 0)
  assert.equal(next.observedProgressRevision, 0)
  assert.deepEqual(next.evidence, [])
  assert.ok(next.requirements.every((item) => item.status === "pending"))
})

test("V2 Todo telemetry fails closed for malformed, other-session, and inactive events", () => {
  const goal = createGoal({ sessionID: "todo-v2-guard", objective: "finish work", now: 100 })

  assert.equal(openCode2TodoUpdate({ type: "session.todo.updated", data: { sessionID: goal.sessionID, todos: TODOS } }), undefined)
  assert.equal(openCode2TodoUpdate({ type: "todo.updated", data: { sessionID: goal.sessionID, todos: [{ content: "", status: "pending" }] } }), undefined)

  const other = applyOpenCode2TodoUpdate(goal, {
    type: "todo.updated",
    data: { sessionID: "someone-else", todos: TODOS },
  }, 200)
  assert.equal(other, goal)

  const paused = pauseGoal(goal, "pause", 150)
  const pausedResult = applyOpenCode2TodoUpdate(paused, {
    type: "todo.updated",
    data: { sessionID: goal.sessionID, todos: TODOS },
  }, 200)
  assert.equal(pausedResult, paused)
})

test("V2 Todo telemetry preserves stale revision behavior until the native plan is rebuilt", () => {
  let goal = createGoal({ sessionID: "todo-v2-revision", objective: "first objective", now: 100 })
  const event = { type: "todo.updated", data: { sessionID: goal.sessionID, todos: TODOS } }
  goal = applyOpenCode2TodoUpdate(goal, event, 150)
  const first = goal.todoPlan

  goal = editGoal(goal, { objective: "changed objective" }, 200)
  assert.notEqual(goal.revision, first.goalRevision)

  const replay = applyOpenCode2TodoUpdate(goal, event, 250)
  assert.equal(replay, goal, "unchanged native Todo replay must remain visibly stale after Goal edit")

  const rebuilt = applyOpenCode2TodoUpdate(goal, {
    type: "todo.updated",
    data: {
      sessionID: goal.sessionID,
      todos: [
        ...TODOS.slice(0, 2),
        { content: "Verify changed objective", status: "pending", priority: "medium" },
      ],
    },
  }, 300)
  assert.equal(rebuilt.todoPlan.goalRevision, rebuilt.revision)
  assert.notEqual(rebuilt.todoPlan.digest, first.digest)
})
