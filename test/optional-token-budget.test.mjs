import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { budgetLimitHits } from "../dist/runtime/accounting.js"
import { observeModelContextLimits } from "../dist/runtime/model-context.js"

test("new goals default cumulative token budget to unlimited", () => {
  const goal = createGoal({ sessionID: "default", objective: "finish the work" })
  assert.equal(goal.budget.maxTokens, 0)
})

test("observed model limits do not rewrite cumulative Goal token budget", () => {
  let goal = createGoal({ sessionID: "context", objective: "finish the work" })
  goal.usage.tokens = 450_000

  goal = observeModelContextLimits(goal, {
    model: { limit: { context: 1_000_000, input: 272_000, output: 131_072 } },
    autoCompaction: true,
  })

  assert.equal(goal.budget.maxTokens, 0)
  assert.equal(goal.execution.modelContext.contextLimit, 1_000_000)
  assert.equal(goal.execution.modelContext.inputLimit, 272_000)
  assert.equal(goal.execution.modelContext.outputLimit, 131_072)
  assert.equal(budgetLimitHits(goal.usage, goal.budget).some((hit) => hit.kind === "tokens"), false)
})

test("explicit cumulative token budgets remain hard safety guards", () => {
  const goal = createGoal({
    sessionID: "manual",
    objective: "finish the work",
    budget: { maxTokens: 900_000 },
  })
  goal.usage.tokens = 900_000

  assert.equal(goal.budget.maxTokens, 900_000)
  assert.equal(budgetLimitHits(goal.usage, goal.budget).some((hit) => hit.kind === "tokens"), true)
})

test("persisted legacy token budgets remain respected", () => {
  const goal = createGoal({ sessionID: "legacy", objective: "finish the work" })
  goal.budget.maxTokens = 400_000
  goal.usage.tokens = 400_000

  assert.equal(budgetLimitHits(goal.usage, goal.budget).some((hit) => hit.kind === "tokens"), true)
})
