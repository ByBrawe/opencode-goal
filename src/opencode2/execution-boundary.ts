import type { GoalState } from "../domain/types.js"
import { closeObservedTurn } from "../runtime/progress.js"

type UnknownRecord = Record<string, unknown>

export type OpenCode2ExecutionTerminal = "succeeded" | "failed" | "interrupted"

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? value as UnknownRecord : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export function openCode2ExecutionTerminal(event: unknown): OpenCode2ExecutionTerminal | undefined {
  const type = firstString(record(event)?.type)
  if (type === "session.execution.succeeded") return "succeeded"
  if (type === "session.execution.failed") return "failed"
  if (type === "session.execution.interrupted") return "interrupted"
  return undefined
}

export function openCode2ExecutionSessionID(event: unknown): string | undefined {
  const item = record(event)
  const properties = record(item?.properties)
  const data = record(item?.data)
  return firstString(
    properties?.sessionID,
    data?.sessionID,
    item?.sessionID,
  )
}

export function settleGoalForOpenCode2ExecutionEvent(
  goal: GoalState,
  event: unknown,
  input: { maxStalledTurns?: number; now?: number } = {},
): { goal: GoalState; terminal?: OpenCode2ExecutionTerminal; closed: boolean } {
  const terminal = openCode2ExecutionTerminal(event)
  if (terminal !== "succeeded" || goal.status !== "active") {
    return { goal, ...(terminal ? { terminal } : {}), closed: false }
  }

  return {
    goal: closeObservedTurn(goal, input),
    terminal,
    closed: true,
  }
}
