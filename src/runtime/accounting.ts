import type { GoalBudget, GoalState, GoalUsage } from "../domain/types.js"

export interface AssistantUsageSample {
  messageID: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cost?: number
  createdAt?: number
  completedAt?: number
}

export type BudgetLimitKind = "turns" | "tokens" | "cost" | "runtime"

export interface BudgetLimitHit {
  kind: BudgetLimitKind
  used: number
  limit: number
}

export function budgetLimitHits(usage: GoalUsage, budget: GoalBudget): BudgetLimitHit[] {
  const hits: BudgetLimitHit[] = []
  if (budget.maxTurns > 0 && usage.turns >= budget.maxTurns) hits.push({ kind: "turns", used: usage.turns, limit: budget.maxTurns })
  if (budget.maxTokens > 0 && usage.tokens >= budget.maxTokens) hits.push({ kind: "tokens", used: usage.tokens, limit: budget.maxTokens })
  if (budget.maxCost > 0 && usage.cost >= budget.maxCost) hits.push({ kind: "cost", used: usage.cost, limit: budget.maxCost })
  if (budget.maxRuntimeMs > 0 && usage.runtimeMs >= budget.maxRuntimeMs) hits.push({ kind: "runtime", used: usage.runtimeMs, limit: budget.maxRuntimeMs })
  return hits
}

function compactDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

function limitValue(kind: BudgetLimitKind, value: number): string {
  if (kind === "cost") return value.toFixed(4)
  if (kind === "runtime") return compactDuration(value)
  return Math.round(value).toLocaleString("en-US")
}

function limitLabel(kind: BudgetLimitKind): string {
  if (kind === "turns") return "turns"
  if (kind === "tokens") return "tokens"
  if (kind === "cost") return "cost"
  return "runtime"
}

export function budgetStopReason(usage: GoalUsage, budget: GoalBudget): string | undefined {
  const hits = budgetLimitHits(usage, budget)
  if (!hits.length) return undefined
  const detail = hits.map((hit) => `${limitLabel(hit.kind)} ${limitValue(hit.kind, hit.used)} / ${limitValue(hit.kind, hit.limit)}`).join("; ")
  return `Goal budget reached: ${detail}.`
}

function budgetValue(kind: BudgetLimitKind, value: number): string {
  if (value <= 0) return "unlimited"
  return limitValue(kind, value)
}

export function formatGoalBudget(goal: Pick<GoalState, "usage" | "budget">): string {
  const { usage, budget } = goal
  return [
    `${limitValue("turns", usage.turns)} / ${budgetValue("turns", budget.maxTurns)} turns`,
    `${limitValue("tokens", usage.tokens)} / ${budgetValue("tokens", budget.maxTokens)} tokens`,
    `cost ${limitValue("cost", usage.cost)} / ${budgetValue("cost", budget.maxCost)}`,
    `runtime ${limitValue("runtime", usage.runtimeMs)} / ${budgetValue("runtime", budget.maxRuntimeMs)}`,
  ].join(" | ")
}

export function applyGoalBudget(goal: GoalState, patch: Partial<GoalBudget>, now = Date.now()): GoalState {
  const budget = { ...goal.budget, ...patch }
  const reason = budgetStopReason(goal.usage, budget)
  let status = goal.status
  let stopReason = goal.stopReason

  if (status === "active" && reason) {
    status = "budget_limited"
    stopReason = reason
  } else if (status === "budget_limited") {
    if (reason) {
      stopReason = reason
    } else {
      status = "active"
      stopReason = undefined
    }
  }

  const { stopReason: _previousStopReason, ...rest } = goal
  return {
    ...rest,
    budget,
    status,
    ...(stopReason ? { stopReason } : {}),
    updatedAt: now,
  }
}

/**
 * Apply a reached cumulative Goal budget only at a host-observed Goal-turn
 * boundary. Usage is accounted as assistant messages finish, but changing the
 * Goal to budget_limited in the middle of one OpenCode prompt can otherwise
 * disable cadence/completion guards while that same prompt is still executing.
 */
export function settleReachedGoalBudget(goal: GoalState, now = Date.now()): GoalState {
  if (goal.status !== "active") return goal
  const reason = budgetStopReason(goal.usage, goal.budget)
  if (!reason) return goal
  const { stopReason: _previousStopReason, ...rest } = goal
  return { ...rest, status: "budget_limited", stopReason: reason, updatedAt: now }
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
  // Budget state is intentionally settled by closeObservedTurn/session.idle so
  // the currently executing Goal-owned prompt can still enforce its mutation
  // cadence and attempt final verification before autonomous continuation stops.
  return { ...goal, usage, updatedAt: now }
}
