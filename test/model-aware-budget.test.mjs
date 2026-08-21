import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { applyGoalBudget } from "../dist/runtime/accounting.js"
import { automaticGoalTokenBudget, observeModelContextLimits } from "../dist/runtime/model-context.js"

test("new goals scale cumulative token budget from observed model context", () => {
  let goal = createGoal({ sessionID: "auto", objective: "finish the work" })
  assert.equal(goal.budget.maxTokens, 400_000)
  assert.equal(goal.budgetTokenMode, "auto")

  goal = observeModelContextLimits(goal, {
    model: { limit: { context: 1_000_000, input: 272_000, output: 131_072 } },
    autoCompaction: true,
    now: 100,
  })

  assert.equal(goal.budget.maxTokens, 3_000_000)
  assert.equal(goal.budgetTokenMode, "auto")
  assert.equal(goal.execution.modelContext.contextLimit, 1_000_000)
  assert.equal(goal.execution.modelContext.inputLimit, 272_000)
})

test("automatic token budgets keep a 400k safety floor for small contexts", () => {
  assert.equal(automaticGoalTokenBudget(64_000), 400_000)
  assert.equal(automaticGoalTokenBudget(128_000), 400_000)
  assert.equal(automaticGoalTokenBudget(256_000), 768_000)
})

test("explicit maxTokens keeps the goal in manual mode", () => {
  let goal = createGoal({
    sessionID: "manual-create",
    objective: "finish the work",
    budget: { maxTokens: 900_000 },
  })
  assert.equal(goal.budgetTokenMode, "manual")

  goal = observeModelContextLimits(goal, {
    model: { limit: { context: 1_000_000 } },
    autoCompaction: true,
  })
  assert.equal(goal.budget.maxTokens, 900_000)
})

test("budget command semantics switch an automatic token budget to manual", () => {
  let goal = createGoal({ sessionID: "manual-patch", objective: "finish the work" })
  goal = observeModelContextLimits(goal, { model: { limit: { context: 1_000_000 } } })
  assert.equal(goal.budget.maxTokens, 3_000_000)

  goal = applyGoalBudget(goal, { maxTokens: 0 })
  assert.equal(goal.budget.maxTokens, 0)
  assert.equal(goal.budgetTokenMode, "manual")

  goal = observeModelContextLimits(goal, { model: { limit: { context: 2_000_000 } } })
  assert.equal(goal.budget.maxTokens, 0, "manual/unlimited token budget must not be overwritten by later model telemetry")
})

test("legacy goals without budgetTokenMode keep their existing token budget", () => {
  let goal = createGoal({ sessionID: "legacy", objective: "finish the work" })
  delete goal.budgetTokenMode
  goal.budget.maxTokens = 400_000

  goal = observeModelContextLimits(goal, { model: { limit: { context: 1_000_000 } } })
  assert.equal(goal.budget.maxTokens, 400_000)
  assert.equal(goal.budgetTokenMode, undefined)
})

test("automatic model observation can reactivate an auto goal stopped only by the fallback token budget", () => {
  let goal = createGoal({ sessionID: "reactivate", objective: "finish the work" })
  goal.usage.tokens = 450_000
  goal.status = "budget_limited"
  goal.stopReason = "Goal budget reached: tokens 450,000 / 400,000."

  goal = observeModelContextLimits(goal, { model: { limit: { context: 1_000_000 } }, now: 200 })
  assert.equal(goal.budget.maxTokens, 3_000_000)
  assert.equal(goal.status, "active")
  assert.equal(goal.stopReason, undefined)
})
