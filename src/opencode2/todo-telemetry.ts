import type { GoalState } from "../domain/types.js"
import { normalizeNativeTodos, observeTodoPlan, type NativeTodoItem } from "../runtime/todo-plan.js"

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export function openCode2TodoUpdate(event: unknown): {
  sessionID: string
  todos: NativeTodoItem[]
} | undefined {
  const item = record(event)
  if (firstString(item?.type) !== "todo.updated") return undefined
  const data = record(item?.data) ?? record(item?.properties)
  const sessionID = firstString(data?.sessionID, item?.sessionID)
  if (!sessionID) return undefined
  const todos = normalizeNativeTodos(data?.todos)
  if (!todos) return undefined
  return { sessionID, todos }
}

export function applyOpenCode2TodoUpdate(
  goal: GoalState,
  event: unknown,
  observedAt = Date.now(),
): GoalState {
  const update = openCode2TodoUpdate(event)
  if (!update || update.sessionID !== goal.sessionID || goal.status !== "active") return goal
  return observeTodoPlan(goal, update.todos, observedAt)
}
