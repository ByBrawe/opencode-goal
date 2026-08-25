import test from "node:test"
import assert from "node:assert/strict"
import { createGoal } from "../dist/domain/goal.js"
import { accountAssistantUsage, applyGoalBudget, budgetLimitHits, budgetStopReason, formatGoalBudget } from "../dist/runtime/accounting.js"
import { isTransientInfrastructureError } from "../dist/runtime/infrastructure-recovery.js"
import {
  fatalProviderReason,
  hostUsageLimitReason,
  isProviderPromptOverflowError,
  markUsageLimited,
  pauseForFatalProviderError,
  providerPromptOverflowReason,
} from "../dist/runtime/limits.js"
import { closeObservedTurn } from "../dist/runtime/progress.js"
import { parseGoalCommand } from "../dist/opencode/command.js"

test("budget exhaustion is accounted immediately but settles at the Goal turn boundary", () => {
  let goal = createGoal({
    sessionID: "s1",
    objective: "work",
    budget: { maxTurns: 2, maxTokens: 100, maxCost: 0, maxRuntimeMs: 0 },
  })
  goal = accountAssistantUsage(goal, { messageID: "m1", inputTokens: 20, outputTokens: 10 })
  goal = accountAssistantUsage(goal, { messageID: "m2", inputTokens: 20, outputTokens: 10 })
  assert.equal(goal.status, "active")
  assert.equal(goal.stopReason, undefined)
  assert.deepEqual(budgetLimitHits(goal.usage, goal.budget).map((item) => item.kind), ["turns"])

  goal = closeObservedTurn(goal)
  assert.equal(goal.status, "budget_limited")
  assert.match(goal.stopReason, /turns 2 \/ 2/)
})

test("multiple budget limits settle without double-accounting messages", () => {
  let goal = createGoal({
    sessionID: "s1",
    objective: "work",
    budget: { maxTurns: 1, maxTokens: 15, maxCost: 0.5, maxRuntimeMs: 10 },
  })
  const sample = { messageID: "m1", inputTokens: 10, outputTokens: 5, cost: 0.5, createdAt: 0, completedAt: 10 }
  goal = accountAssistantUsage(goal, sample)
  goal = accountAssistantUsage(goal, sample)
  assert.equal(goal.usage.turns, 1)
  assert.equal(goal.status, "active")
  assert.equal(goal.stopReason, undefined)
  goal = closeObservedTurn(goal)
  assert.match(goal.stopReason, /turns 1 \/ 1/)
  assert.match(goal.stopReason, /tokens 15 \/ 15/)
  assert.match(goal.stopReason, /cost 0\.5000 \/ 0\.5000/)
  assert.match(goal.stopReason, /runtime 0s \/ 0s|runtime/)
})

test("raising an exhausted boundary-settled budget reactivates without changing usage", () => {
  let goal = createGoal({ sessionID: "s1", objective: "work", budget: { maxTurns: 1 } })
  goal = accountAssistantUsage(goal, { messageID: "m1" })
  assert.equal(goal.status, "active")
  goal = closeObservedTurn(goal)
  assert.equal(goal.status, "budget_limited")
  const usage = structuredClone(goal.usage)
  goal = applyGoalBudget(goal, { maxTurns: 2 })
  assert.equal(goal.status, "active")
  assert.equal(goal.stopReason, undefined)
  assert.deepEqual(goal.usage, usage)
})

test("zero budget means unlimited and status formatting exposes all limits", () => {
  const goal = applyGoalBudget(createGoal({ sessionID: "s1", objective: "work" }), {
    maxTurns: 0,
    maxTokens: 0,
    maxCost: 0,
    maxRuntimeMs: 0,
  })
  assert.equal(budgetStopReason(goal.usage, goal.budget), undefined)
  assert.match(formatGoalBudget(goal), /0 \/ unlimited turns/)
  assert.match(formatGoalBudget(goal), /0 \/ unlimited tokens/)
  assert.match(formatGoalBudget(goal), /cost 0\.0000 \/ unlimited/)
})

test("goal budget parser accepts zero as unlimited and rejects invalid values", () => {
  const parsed = parseGoalCommand("budget --max-turns 0 --max-tokens 200 --max-minutes 0 --max-cost 0")
  assert.equal(parsed.action, "budget")
  assert.equal(parsed.maxTurns, 0)
  assert.equal(parsed.maxTokens, 200)
  assert.equal(parsed.maxRuntimeMs, 0)
  assert.equal(parsed.maxCost, 0)
  assert.throws(() => parseGoalCommand("budget --max-turns -1"), /non-negative integer/)
  assert.throws(() => parseGoalCommand("budget nonsense --max-turns 2"), /accepts only/)
})

test("only explicit OpenCode usage-limit actions stop a goal as usage_limited", () => {
  const temporary = hostUsageLimitReason({ type: "retry", action: undefined })
  assert.equal(temporary, undefined)
  const reason = hostUsageLimitReason({
    type: "retry",
    action: {
      reason: "account_rate_limit",
      provider: "opencode",
      title: "Go limit reached",
      message: "Usage limit reached. It will reset later.",
      label: "open settings",
    },
  })
  assert.match(reason, /OpenCode provider usage limit \(opencode\)/)
  const limited = markUsageLimited(createGoal({ sessionID: "s1", objective: "work" }), reason)
  assert.equal(limited.status, "usage_limited")
  assert.match(limited.stopReason, /Go limit reached/)
})

test("fatal provider classification ignores retryable failures and aborted errors", () => {
  assert.equal(fatalProviderReason({ name: "APIError", data: { message: "temporary", statusCode: 429, isRetryable: false } }), undefined)
  assert.equal(fatalProviderReason({ name: "MessageAbortedError", data: { message: "aborted" } }), undefined)
  assert.match(fatalProviderReason({ name: "ProviderAuthError", data: { providerID: "p", message: "bad key" } }), /authentication failed.*bad key/i)
  assert.match(fatalProviderReason({ name: "APIError", data: { message: "model missing", statusCode: 404, isRetryable: false } }), /HTTP 404/)
})

test("provider prompt overflow is deterministic context pressure, never transient infrastructure", () => {
  const error = {
    name: "APIError",
    data: {
      providerID: "opencode",
      statusCode: 400,
      isRetryable: false,
      message: "Error from provider (Console): Upstream request failed: [1261] Prompt exceeds max length",
    },
  }
  assert.equal(isProviderPromptOverflowError(error), true)
  assert.match(providerPromptOverflowReason(error), /prompt\/context limit.*HTTP 400.*Prompt exceeds max length/i)
  assert.equal(isTransientInfrastructureError(error), false)
  assert.equal(isTransientInfrastructureError(JSON.stringify(error)), false)
})

test("fatal provider pause clears stale infrastructure retry metadata", () => {
  const goal = {
    ...createGoal({ sessionID: "s-overflow", objective: "work" }),
    infrastructureRecovery: {
      kind: "provider_retry",
      reason: "old retry",
      attempt: 1,
      startedAt: 1,
      nextRetryAt: 2,
    },
    skipNextStallCheck: true,
  }
  const paused = pauseForFatalProviderError(goal, "Provider request failed (HTTP 400): Prompt exceeds max length", 100)
  assert.equal(paused.status, "paused")
  assert.equal(paused.infrastructureRecovery, undefined)
  assert.equal(paused.skipNextStallCheck, undefined)
})
