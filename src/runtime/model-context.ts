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

function positive(value: unknown): number | undefined {
  const number = nonNegative(value)
  return number !== undefined && number > 0 ? number : undefined
}

/**
 * Return a compactable pressure reason when the last host-observed request no
 * longer leaves safe room for the model's output/reserved context. This is a
 * pre-dispatch guard, not Goal-budget accounting.
 */
export function modelContextCompactionReason(
  goal: Pick<GoalState, "execution">,
  options: { respectAutoCompaction?: boolean } = {},
): string | undefined {
  const context = goal.execution?.modelContext
  if (!context) return undefined
  if (options.respectAutoCompaction !== false && context.autoCompaction === false) return undefined

  const contextLimit = positive(context.contextLimit)
  const request = positive(context.lastRequestTokens)
  if (contextLimit && request) {
    const explicitReserve = Math.max(
      positive(context.outputLimit) ?? 0,
      positive(context.compactionReserved) ?? 0,
    )
    const minimumReserve = Math.max(8_192, Math.floor(contextLimit * 0.10))
    const reserve = Math.max(explicitReserve, minimumReserve)
    if (request + reserve >= contextLimit) {
      const percent = ((request / contextLimit) * 100).toFixed(1)
      return `Host-observed model context pressure is ${percent}% (${Math.round(request)} / ${Math.round(contextLimit)} tokens) with ${Math.round(reserve)} tokens of required output/compaction headroom.`
    }
  }

  const inputLimit = positive(context.inputLimit)
  const input = positive(context.lastInputTokens)
  if (inputLimit && input && input >= inputLimit * 0.90) {
    const percent = ((input / inputLimit) * 100).toFixed(1)
    return `Host-observed model input pressure is ${percent}% (${Math.round(input)} / ${Math.round(inputLimit)} tokens).`
  }
  return undefined
}

export function clearObservedModelContextUsage(goal: GoalState, now = Date.now()): GoalState {
  const execution = goal.execution
  const context = execution?.modelContext
  if (!execution || !context) return goal
  const { lastRequestTokens: _lastRequestTokens, lastInputTokens: _lastInputTokens, ...rest } = context
  return {
    ...goal,
    execution: { ...execution, modelContext: { ...rest, observedAt: now } },
    updatedAt: now,
  }
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
