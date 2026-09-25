import type { GoalState } from "../domain/types.js"
import { observeModelContextLimits } from "../runtime/model-context.js"

type UnknownRecord = Record<string, unknown>

export interface OpenCode2ModelRegistry {
  list?: () => unknown | Promise<unknown>
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? value as UnknownRecord : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function registryModels(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const data = record(value)?.data
  return Array.isArray(data) ? data : []
}

export function selectOpenCode2RegistryModel(
  models: unknown,
  selected: unknown,
): UnknownRecord | undefined {
  const selection = record(selected)
  const providerID = firstString(selection?.providerID)
  const modelID = firstString(selection?.id, selection?.modelID)
  if (!providerID || !modelID) return undefined

  for (const value of registryModels(models)) {
    const model = record(value)
    if (!model) continue
    if (firstString(model.providerID) !== providerID) continue
    if (firstString(model.id, model.modelID) !== modelID) continue
    return model
  }
  return undefined
}

/**
 * Resolve exact OpenCode 2 selected-model limits through ctx.model.list().
 *
 * OpenCode 2.0.11 session.context.model carries only identity. The model
 * registry is the exact-host source for context/output limits. Failure to read
 * that registry is advisory and must never block Goal work or invent limits.
 */
function nonNegative(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export async function observeOpenCode2ModelRegistryLimits(
  goal: GoalState,
  registry: OpenCode2ModelRegistry | undefined,
  selected: unknown,
  now = Date.now(),
): Promise<GoalState> {
  if (typeof registry?.list !== "function") return goal

  let models: unknown
  try {
    models = await registry.list()
  } catch {
    return goal
  }

  const model = selectOpenCode2RegistryModel(models, selected)
  if (!model) return goal

  const selection = record(selected)
  const providerID = firstString(selection?.providerID)
  const modelID = firstString(selection?.id, selection?.modelID)
  if (!providerID || !modelID) return goal

  const execution = goal.execution ?? {}
  const previousModel = execution.model
  const modelChanged = Boolean(
    previousModel
    && (
      previousModel.providerID !== providerID
      || previousModel.modelID !== modelID
    )
  )

  let base = goal
  if (!previousModel || modelChanged) {
    const { modelContext: previousContext, ...rest } = execution
    base = {
      ...goal,
      execution: {
        ...rest,
        model: { providerID, modelID },
        ...(!modelChanged && previousContext ? { modelContext: previousContext } : {}),
      },
      updatedAt: now,
    }
  }

  const limit = record(model.limit)
  const contextLimit = nonNegative(limit?.context)
  const inputLimit = nonNegative(limit?.input)
  const outputLimit = nonNegative(limit?.output)
  if (contextLimit === undefined && inputLimit === undefined && outputLimit === undefined) return base

  const current = base.execution?.modelContext
  if (
    current?.contextLimit === contextLimit
    && current?.inputLimit === inputLimit
    && current?.outputLimit === outputLimit
  ) return base

  return observeModelContextLimits(base, { model, now })
}
