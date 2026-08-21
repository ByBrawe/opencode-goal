import type { GoalModelContext, GoalState } from "../domain/types.js"
import { applyGoalBudget } from "./accounting.js"

const DEFAULT_GOAL_TOKEN_BUDGET = 400_000
const CONTEXT_BUDGET_MULTIPLIER = 3

function nonNegative(value: unknown): number | undefined {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return undefined
  return number
}

function tokenCount(tokens: any): number | undefined {
  const explicit = nonNegative(tokens?.total)
  if (explicit !== undefined && explicit > 0) return explicit
  const input = nonNegative(tokens?.input) ?? 0
  const output = nonNegative(tokens?.output) ?? 0
  const cacheRead = nonNegative(tokens?.cache?.read) ?? 0
  const cacheWrite = nonNegative(tokens?.cache?.write) ?? 0
  const total = input + output + cacheRead + cacheWrite
  return total > 0 ? total : undefined
}

function updateContext(goal: GoalState, patch: Partial<GoalModelContext>, now: number): GoalState {
  const execution = goal.execution ?? {}
  const current = execution.modelContext ?? {}
  const next: GoalModelContext = {
    ...current,
    ...patch,
    observedAt: now,
  }
  return {
    ...goal,
    execution: { ...execution, modelContext: next },
    updatedAt: now,
  }
}

export function automaticGoalTokenBudget(contextLimit: number | undefined): number | undefined {
  if (contextLimit === undefined || contextLimit <= 0) return undefined
  return Math.max(DEFAULT_GOAL_TOKEN_BUDGET, Math.round(contextLimit * CONTEXT_BUDGET_MULTIPLIER))
}

function adaptAutomaticTokenBudget(goal: GoalState, contextLimit: number | undefined, now: number): GoalState {
  if (goal.budgetTokenMode !== "auto") return goal
  const maxTokens = automaticGoalTokenBudget(contextLimit)
  if (maxTokens === undefined || maxTokens === goal.budget.maxTokens) return goal
  return applyGoalBudget(goal, { maxTokens }, now, "auto")
}

export function observeModelContextLimits(goal: GoalState, input: {
  model?: any
  autoCompaction?: boolean
  compactionReserved?: number
  now?: number
}): GoalState {
  const limit = input.model?.limit
  const contextLimit = nonNegative(limit?.context)
  const inputLimit = nonNegative(limit?.input)
  const outputLimit = nonNegative(limit?.output)
  if (contextLimit === undefined && inputLimit === undefined && outputLimit === undefined && input.autoCompaction === undefined) return goal
  const now = input.now ?? Date.now()
  const withContext = updateContext(goal, {
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(inputLimit !== undefined ? { inputLimit } : {}),
    ...(outputLimit !== undefined ? { outputLimit } : {}),
    ...(input.autoCompaction !== undefined ? { autoCompaction: input.autoCompaction } : {}),
    ...(input.compactionReserved !== undefined ? { compactionReserved: input.compactionReserved } : {}),
  }, now)
  return adaptAutomaticTokenBudget(withContext, contextLimit ?? withContext.execution?.modelContext?.contextLimit, now)
}

export function observeModelContextUsage(goal: GoalState, tokens: any, now = Date.now()): GoalState {
  const lastRequestTokens = tokenCount(tokens)
  if (lastRequestTokens === undefined) return goal
  return updateContext(goal, { lastRequestTokens }, now)
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

export function formatModelContext(goal: Pick<GoalState, "execution">): string {
  const model = goal.execution?.model
  const context = goal.execution?.modelContext
  const modelName = model ? `${model.providerID}/${model.modelID}` : "unbound"
  if (!context) return `${modelName} | limits not observed yet`

  const parts = [modelName]
  if (context.contextLimit && context.contextLimit > 0) {
    const usage = context.lastRequestTokens
    if (usage !== undefined) {
      const percent = Math.min(999, Math.max(0, (usage / context.contextLimit) * 100))
      parts.push(`last request ${formatNumber(usage)} / ${formatNumber(context.contextLimit)} context (${percent.toFixed(1)}%)`)
    } else {
      parts.push(`context window ${formatNumber(context.contextLimit)}`)
    }
  } else if (context.lastRequestTokens !== undefined) {
    parts.push(`last request ${formatNumber(context.lastRequestTokens)} tokens`)
  }
  if (context.inputLimit !== undefined) parts.push(`input limit ${formatNumber(context.inputLimit)}`)
  if (context.outputLimit !== undefined) parts.push(`output limit ${formatNumber(context.outputLimit)}`)
  if (context.autoCompaction !== undefined) parts.push(`OpenCode auto-compaction ${context.autoCompaction ? "on" : "off"}`)
  return parts.join(" | ")
}
