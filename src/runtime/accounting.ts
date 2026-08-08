import type { GoalState } from "../domain/types.js"

export interface AssistantUsageSample {
  messageID: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cost?: number
  createdAt?: number
  completedAt?: number
}

export function accountAssistantUsage(goal: GoalState, sample: AssistantUsageSample, now = Date.now()): GoalState {
  if (!sample.messageID || goal.usage.seenMessageIDs.includes(sample.messageID)) return goal
  const tokens = Math.max(0, sample.inputTokens ?? 0) + Math.max(0, sample.outputTokens ?? 0) + Math.max(0, sample.reasoningTokens ?? 0)
  const runtimeMs = sample.createdAt !== undefined && sample.completedAt !== undefined
    ? Math.max(0, sample.completedAt - sample.createdAt)
    : 0
  const usage = {
    turns: goal.usage.turns + 1,
    tokens: goal.usage.tokens + tokens,
    cost: goal.usage.cost + Math.max(0, sample.cost ?? 0),
    runtimeMs: goal.usage.runtimeMs + runtimeMs,
    seenMessageIDs: [...goal.usage.seenMessageIDs, sample.messageID].slice(-5000),
  }
  let status = goal.status
  let stopReason = goal.stopReason
  const exceeded =
    (goal.budget.maxTurns > 0 && usage.turns >= goal.budget.maxTurns) ||
    (goal.budget.maxTokens > 0 && usage.tokens >= goal.budget.maxTokens) ||
    (goal.budget.maxCost > 0 && usage.cost >= goal.budget.maxCost) ||
    (goal.budget.maxRuntimeMs > 0 && usage.runtimeMs >= goal.budget.maxRuntimeMs)
  if (exceeded && status === "active") {
    status = "budget_limited"
    stopReason = "Goal budget reached."
  }
  return { ...goal, usage, status, ...(stopReason ? { stopReason } : {}), updatedAt: now }
}
