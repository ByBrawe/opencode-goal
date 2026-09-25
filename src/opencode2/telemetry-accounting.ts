import type { GoalState } from "../domain/types.js"
import type { OpenCode2GoalExecutionOwner } from "./autonomous-runtime.js"
import { accountAssistantUsage, type AssistantUsageSample } from "../runtime/accounting.js"
import { clearEmptyAssistantTurnStreak, recordEmptyAssistantTurn } from "../runtime/empty-turn.js"
import { observeModelContextUsage } from "../runtime/model-context.js"

type UnknownRecord = Record<string, unknown>

interface AssistantTelemetry {
  startedAt?: number
  meaningful: boolean
}

export interface OpenCode2AssistantStepObservation {
  sessionID: string
  assistantMessageID: string
  meaningful: boolean
  tokens?: any
  cost?: number
  startedAt?: number
  completedAt?: number
}

export interface OpenCode2TelemetryAccountingRuntime {
  assistants: Map<string, AssistantTelemetry>
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

function finite(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function eventData(event: unknown): UnknownRecord {
  return record(record(event)?.data) ?? record(record(event)?.properties) ?? {}
}

function eventType(event: unknown): string | undefined {
  return firstString(record(event)?.type)
}

function eventCreatedAt(event: unknown): number | undefined {
  return finite(record(event)?.created)
}

function key(sessionID: string, assistantMessageID: string): string {
  return `${sessionID}\u0000${assistantMessageID}`
}

function identity(event: unknown): { sessionID?: string; assistantMessageID?: string } {
  const data = eventData(event)
  const sessionID = firstString(data.sessionID, record(event)?.sessionID)
  const assistantMessageID = firstString(data.assistantMessageID)
  return {
    ...(sessionID ? { sessionID } : {}),
    ...(assistantMessageID ? { assistantMessageID } : {}),
  }
}

function ensure(runtime: OpenCode2TelemetryAccountingRuntime, sessionID: string, assistantMessageID: string): AssistantTelemetry {
  const id = key(sessionID, assistantMessageID)
  let item = runtime.assistants.get(id)
  if (!item) {
    item = { meaningful: false }
    runtime.assistants.set(id, item)
  }
  return item
}

export function createOpenCode2TelemetryAccountingRuntime(): OpenCode2TelemetryAccountingRuntime {
  return { assistants: new Map() }
}

export function clearOpenCode2TelemetrySession(runtime: OpenCode2TelemetryAccountingRuntime, sessionID: string): void {
  const prefix = `${sessionID}\u0000`
  for (const id of runtime.assistants.keys()) {
    if (id.startsWith(prefix)) runtime.assistants.delete(id)
  }
}

/**
 * Consume exact OpenCode 2 assistant-step telemetry.
 *
 * Exact 2.0.11 proves that step.ended is per assistant message, while
 * usage.updated is cumulative at session scope. Goal accounting therefore
 * consumes step.ended only and treats usage.updated as advisory telemetry.
 */
export function observeOpenCode2AssistantTelemetry(
  runtime: OpenCode2TelemetryAccountingRuntime,
  event: unknown,
): OpenCode2AssistantStepObservation | undefined {
  const type = eventType(event)
  const ids = identity(event)

  if (type === "session.deleted" && ids.sessionID) {
    clearOpenCode2TelemetrySession(runtime, ids.sessionID)
    return undefined
  }

  if (!ids.sessionID || !ids.assistantMessageID) return undefined

  if (type === "session.step.started") {
    const item = ensure(runtime, ids.sessionID, ids.assistantMessageID)
    const startedAt = eventCreatedAt(event)
    if (item.startedAt === undefined && startedAt !== undefined) item.startedAt = startedAt
    return undefined
  }

  if (type === "session.text.ended") {
    const data = eventData(event)
    if (typeof data.text === "string" && data.text.trim()) {
      ensure(runtime, ids.sessionID, ids.assistantMessageID).meaningful = true
    }
    return undefined
  }

  if (type === "session.tool.input.started") {
    ensure(runtime, ids.sessionID, ids.assistantMessageID).meaningful = true
    return undefined
  }

  if (type !== "session.step.ended") return undefined

  const data = eventData(event)
  const id = key(ids.sessionID, ids.assistantMessageID)
  const tracked = runtime.assistants.get(id)
  runtime.assistants.delete(id)
  const cost = finite(data.cost)
  const completedAt = eventCreatedAt(event)
  return {
    sessionID: ids.sessionID,
    assistantMessageID: ids.assistantMessageID,
    meaningful: tracked?.meaningful === true,
    ...(data.tokens && typeof data.tokens === "object" ? { tokens: data.tokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(tracked?.startedAt !== undefined ? { startedAt: tracked.startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  }
}

export function applyOpenCode2AssistantStepAccounting(
  goal: GoalState,
  owner: Pick<OpenCode2GoalExecutionOwner, "goalID" | "revision">,
  step: OpenCode2AssistantStepObservation,
  now = Date.now(),
): GoalState {
  if (owner.goalID !== goal.id || goal.usage.seenMessageIDs.includes(step.assistantMessageID)) return goal

  const tokens = step.tokens
  const inputTokens = finite(tokens?.input)
  const outputTokens = finite(tokens?.output)
  const reasoningTokens = finite(tokens?.reasoning)
  const sample: AssistantUsageSample = {
    messageID: step.assistantMessageID,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(step.cost !== undefined ? { cost: step.cost } : {}),
    ...(step.startedAt !== undefined ? { createdAt: step.startedAt } : {}),
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
  }

  const currentRevision = owner.revision === goal.revision
  let next: GoalState
  if (!step.meaningful && currentRevision && goal.status === "active") {
    next = recordEmptyAssistantTurn(goal, sample, { now })
  } else {
    next = accountAssistantUsage(goal, sample, now)
    if (step.meaningful && currentRevision) next = clearEmptyAssistantTurnStreak(next)
  }

  return observeModelContextUsage(next, tokens, now)
}
