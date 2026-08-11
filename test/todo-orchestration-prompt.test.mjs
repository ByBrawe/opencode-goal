import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import { formatGoalAudit } from "../dist/opencode/audit-ux.js"
import { compactionContext, continuationPrompt } from "../dist/opencode/prompt.js"
import { observeTodoPlan } from "../dist/runtime/todo-plan.js"

const todos = [
  { content: "Inspect current repository state", status: "completed", priority: "high" },
  { content: "Fix required product gaps", status: "in_progress", priority: "high" },
  { content: "Run acceptance verification", status: "pending", priority: "high" },
]

test("broad Goal continuation coordinates native Todos without making them completion evidence", () => {
  let goal = createGoal({
    sessionID: "todo-prompt",
    objective: "analyze this project, identify incomplete required work, and finish it",
    now: 100,
  })

  let prompt = continuationPrompt(goal)
  assert.match(prompt, /Native OpenCode Todos are the execution plan; this Goal contract is the persistent success boundary/)
  assert.match(prompt, /broad\/discovery-shaped objectives or work with 3\+ distinct required steps, use the native todowrite tool/)
  assert.match(prompt, /First inspect enough current repository\/external state to derive concrete required work/)
  assert.match(prompt, /Assistant suggestions, nice-to-haves, and unrelated cleanup are not authorized scope/)
  assert.match(prompt, /Todo completion itself still proves nothing/)
  assert.match(prompt, /If todowrite is unavailable or denied, continue with the Goal normally/)

  goal = observeTodoPlan(goal, todos, 200)
  prompt = continuationPrompt(goal)
  assert.match(prompt, /Native OpenCode Todo plan: current r1; 3 total \(1 pending, 1 in progress, 1 completed, 0 cancelled\)/)
  assert.match(prompt, /no item should remain in_progress; any pending item that is actually required means keep working/)

  const compacted = compactionContext(goal)
  assert.match(compacted, /Native Todos are advisory execution-planning state only/)
  assert.match(compacted, /never use Todo completion as Goal evidence/)

  const audit = formatGoalAudit(goal)
  assert.match(audit, /Native Todo plan: current r1; 3 total/)
  assert.match(audit, /advisory; never completion evidence/)
})

test("Goal edit keeps prior native Todo telemetry visibly stale until the plan is rebuilt", () => {
  let goal = createGoal({ sessionID: "todo-stale", objective: "analyze and fix the project", now: 100 })
  goal = observeTodoPlan(goal, todos, 200)
  goal = editGoal(goal, {
    objective: "analyze and fix the project while preserving the public API",
    now: 300,
  })

  assert.equal(goal.revision, 2)
  const prompt = continuationPrompt(goal)
  assert.match(prompt, /Native OpenCode Todo plan: STALE r1/)
  assert.match(prompt, /stale; rebuild it before relying on it/)
  assert.match(prompt, /If the Todo plan is stale after a Goal edit, restart, or changed understanding, rebuild\/replace it/)

  const audit = formatGoalAudit(goal)
  assert.match(audit, /Native Todo plan: STALE r1/)
})
