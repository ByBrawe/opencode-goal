import type { GoalModelContext, GoalState } from "../domain/types.js"

function nonNegative(value: unknown): number | undefined {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return undefined
  return number
}

function inputTokenCount(tokens: any): number | undefined {
  const input = nonNegative(tokens?.input)
  const cacheRead = nonNegative(tokens?.cache?.read)
  const cacheWrite = nonNegative(tokens?.cache?.write)
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined
  return (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
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
  return updateContext(goal, {
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(inputLimit !== undefined ? { inputLimit } : {}),
    ...(outputLimit !== undefined ? { outputLimit } : {}),
    ...(input.autoCompaction !== undefined ? { autoCompaction: input.autoCompaction } : {}),
    ...(input.compactionReserved !== undefined ? { compactionReserved: input.compactionReserved } : {}),
  }, now)
}

export function observeModelContextUsage(goal: GoalState, tokens: any, now = Date.now()): GoalState {
  const lastRequestTokens = tokenCount(tokens)
  const lastInputTokens = inputTokenCount(tokens)
  if (lastRequestTokens === undefined && lastInputTokens === undefined) return goal
  return updateContext(goal, {
    ...(lastRequestTokens !== undefined ? { lastRequestTokens } : {}),
    ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
  }, now)
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

function percent(used: number, limit: number): string {
  return Math.min(999, Math.max(0, (used / limit) * 100)).toFixed(1)
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
      parts.push(`last request ${formatNumber(usage)} / ${formatNumber(context.contextLimit)} context (${percent(usage, context.contextLimit)}%)`)
    } else {
      parts.push(`context window ${formatNumber(context.contextLimit)}`)
    }
  } else if (context.lastRequestTokens !== undefined) {
    parts.push(`last request ${formatNumber(context.lastRequestTokens)} tokens`)
  }

  if (context.inputLimit !== undefined) {
    if (context.inputLimit > 0 && context.lastInputTokens !== undefined) {
      parts.push(`last input ${formatNumber(context.lastInputTokens)} / ${formatNumber(context.inputLimit)} input limit (${percent(context.lastInputTokens, context.inputLimit)}%)`)
    } else {
      parts.push(`input limit ${formatNumber(context.inputLimit)}`)
    }
  } else if (context.lastInputTokens !== undefined) {
    parts.push(`last input ${formatNumber(context.lastInputTokens)} tokens`)
  }

  if (context.outputLimit !== undefined) parts.push(`output limit ${formatNumber(context.outputLimit)}`)
  if (context.compactionReserved !== undefined) parts.push(`compaction reserve ${formatNumber(context.compactionReserved)}`)
  if (context.autoCompaction !== undefined) parts.push(`OpenCode auto-compaction ${context.autoCompaction ? "on" : "off"}`)
  return parts.join(" | ")
}
