import { createHash } from "node:crypto"
import type { GoalState, GoalTodoPlan } from "../domain/types.js"

export type NativeTodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface NativeTodoItem {
  content: string
  status: NativeTodoStatus
  priority?: string
  id?: string
}

const TODO_STATUSES = new Set<NativeTodoStatus>(["pending", "in_progress", "completed", "cancelled"])

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

export function validGoalTodoPlan(value: unknown): value is GoalTodoPlan {
  if (!value || typeof value !== "object") return false
  const plan = value as Partial<GoalTodoPlan>
  return nonNegativeInteger(plan.goalRevision)
    && typeof plan.digest === "string"
    && /^sha256:[0-9a-f]{64}$/i.test(plan.digest)
    && nonNegativeInteger(plan.total)
    && nonNegativeInteger(plan.pending)
    && nonNegativeInteger(plan.inProgress)
    && nonNegativeInteger(plan.completed)
    && nonNegativeInteger(plan.cancelled)
    && typeof plan.observedAt === "number"
    && Number.isFinite(plan.observedAt)
    && plan.total === plan.pending + plan.inProgress + plan.completed + plan.cancelled
}

export function normalizeNativeTodos(value: unknown): NativeTodoItem[] | null {
  if (!Array.isArray(value)) return null
  const result: NativeTodoItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null
    const item = raw as Record<string, unknown>
    if (typeof item.content !== "string" || !item.content.trim()) return null
    if (typeof item.status !== "string" || !TODO_STATUSES.has(item.status as NativeTodoStatus)) return null
    if (item.priority !== undefined && typeof item.priority !== "string") return null
    if (item.id !== undefined && typeof item.id !== "string") return null
    result.push({
      content: item.content,
      status: item.status as NativeTodoStatus,
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      ...(item.id === undefined ? {} : { id: item.id }),
    })
  }
  return result
}

export function summarizeTodoPlan(goalRevision: number, todos: NativeTodoItem[], observedAt = Date.now()): GoalTodoPlan {
  const canonical = todos.map((item) => ({
    content: item.content,
    status: item.status,
    priority: item.priority ?? "",
  }))
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`
  return {
    goalRevision,
    digest,
    total: todos.length,
    pending: todos.filter((item) => item.status === "pending").length,
    inProgress: todos.filter((item) => item.status === "in_progress").length,
    completed: todos.filter((item) => item.status === "completed").length,
    cancelled: todos.filter((item) => item.status === "cancelled").length,
    observedAt,
  }
}

export function observeTodoPlan(goal: GoalState, todos: NativeTodoItem[], observedAt = Date.now()): GoalState {
  const next = summarizeTodoPlan(goal.revision, todos, observedAt)
  const previous = validGoalTodoPlan(goal.todoPlan) ? goal.todoPlan : undefined

  // After a Goal edit, preserve the old Todo snapshot as visibly stale and do
  // not let an unchanged native list become current merely because OpenCode
  // re-emitted it. A genuinely rebuilt/changed plan gets a new digest and can
  // then bind to the new Goal revision.
  if (previous && previous.goalRevision !== goal.revision && previous.digest === next.digest) return goal

  if (
    previous?.goalRevision === next.goalRevision
    && previous.digest === next.digest
    && previous.total === next.total
    && previous.pending === next.pending
    && previous.inProgress === next.inProgress
    && previous.completed === next.completed
    && previous.cancelled === next.cancelled
  ) return goal

  return {
    ...goal,
    todoPlan: next,
    updatedAt: observedAt,
  }
}

export function todoPlanIsCurrent(goal: GoalState): boolean {
  return validGoalTodoPlan(goal.todoPlan) && goal.todoPlan.goalRevision === goal.revision
}

export function formatTodoPlan(goal: GoalState): string {
  const plan = validGoalTodoPlan(goal.todoPlan) ? goal.todoPlan : undefined
  if (!plan) return goal.todoPlan === undefined ? "not observed" : "invalid advisory telemetry ignored"
  const freshness = plan.goalRevision === goal.revision ? `current r${plan.goalRevision}` : `STALE r${plan.goalRevision}`
  return `${freshness}; ${plan.total} total (${plan.pending} pending, ${plan.inProgress} in progress, ${plan.completed} completed, ${plan.cancelled} cancelled)`
}
