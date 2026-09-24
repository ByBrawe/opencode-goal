import test from "node:test"
import assert from "node:assert/strict"
import { createGoal, pauseGoal } from "../dist/domain/goal.js"
import { prepareOpenCode2RestartContinuation } from "../dist/opencode2/restart-boundary.js"

test("V2 restart continuation preserves active Goal accounting without closing an interrupted turn", () => {
  const goal = createGoal({ sessionID: "v2-restart", objective: "survive process restart", now: 100 })
  goal.stalledTurns = 2
  goal.progressRevision = 7
  goal.observedProgressRevision = 6
  goal.usage.turns = 11

  const prepared = prepareOpenCode2RestartContinuation(goal, { now: 1_000 })
  assert.equal(prepared.goal, goal)
  assert.equal(prepared.shouldContinue, true)
  assert.equal(prepared.blockedBy, undefined)
  assert.equal(prepared.goal.stalledTurns, 2)
  assert.equal(prepared.goal.progressRevision, 7)
  assert.equal(prepared.goal.observedProgressRevision, 6)
  assert.equal(prepared.goal.usage.turns, 11)
  assert.match(prepared.prompt ?? "", /Continue working toward the active OpenCode goal/)
  assert.match(prepared.prompt ?? "", /survive process restart/)
})

test("V2 restart continuation stays fail-closed for inactive, restricted, budget-reached, and cooldown Goals", () => {
  const base = createGoal({ sessionID: "v2-restart", objective: "restart safely", now: 100 })

  const paused = prepareOpenCode2RestartContinuation(pauseGoal(base, "paused", 200), { now: 1_000 })
  assert.equal(paused.shouldContinue, false)
  assert.equal(paused.blockedBy, "inactive")

  const plan = {
    ...base,
    execution: { ...(base.execution ?? {}), agent: "plan" },
  }
  const restricted = prepareOpenCode2RestartContinuation(plan, { now: 1_000 })
  assert.equal(restricted.shouldContinue, false)
  assert.equal(restricted.blockedBy, "restricted-agent")

  const exhausted = {
    ...base,
    usage: { ...base.usage, turns: 3 },
    budget: { ...base.budget, maxTurns: 3 },
  }
  const budget = prepareOpenCode2RestartContinuation(exhausted, { now: 1_000 })
  assert.equal(budget.shouldContinue, false)
  assert.equal(budget.blockedBy, "budget-reached")

  const cooldown = {
    ...base,
    infrastructureRecovery: {
      kind: "provider_retry",
      reason: "provider unavailable",
      attempt: 2,
      startedAt: 500,
      nextRetryAt: 5_000,
    },
  }
  const waiting = prepareOpenCode2RestartContinuation(cooldown, { now: 1_000 })
  assert.equal(waiting.shouldContinue, false)
  assert.equal(waiting.blockedBy, "infrastructure-recovery")

  const expired = prepareOpenCode2RestartContinuation(cooldown, { now: 6_000 })
  assert.equal(expired.shouldContinue, true)
})
