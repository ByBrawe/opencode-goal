import { createHash } from "node:crypto"
import type {
  GoalState,
  GoalTodoPlan,
  GoalTodoPlanAnomaly,
  GoalTodoPlanItem,
  GoalTodoPlanSource,
} from "../domain/types.js"

export type NativeTodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface NativeTodoItem {
  content: string
  status: NativeTodoStatus
  priority?: string
  id?: string
}

const TODO_STATUSES = new Set<NativeTodoStatus>(["pending", "in_progress", "completed", "cancelled"])
const TODO_ANOMALY_KINDS = new Set(["multiple_in_progress", "completed_regression", "substantial_replacement"])
export const TODO_MANIFEST_CONTEXT_MAX_CHARS = 8_000

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function todoIdentityText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function manifestItems(todos: NativeTodoItem[]): GoalTodoPlanItem[] {
  const occurrences = new Map<string, number>()
  return todos.map((item, order) => {
    const identity = JSON.stringify({
      content: todoIdentityText(item.content),
      priority: item.priority ?? "",
    })
    const identityDigest = createHash("sha256").update(identity).digest("hex").slice(0, 24)
    const occurrence = (occurrences.get(identityDigest) ?? 0) + 1
    occurrences.set(identityDigest, occurrence)
    return {
      key: `todo:${identityDigest}:${occurrence}`,
      content: item.content,
      status: item.status,
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      ...(item.id === undefined ? {} : { nativeID: item.id }),
      order,
    }
  })
}

function validManifestItems(plan: Partial<GoalTodoPlan>): boolean {
  if (plan.items === undefined) return true
  if (!Array.isArray(plan.items) || plan.items.length !== plan.total) return false

  const keys = new Set<string>()
  const counts = { pending: 0, inProgress: 0, completed: 0, cancelled: 0 }
  for (const [index, raw] of plan.items.entries()) {
    if (!raw || typeof raw !== "object") return false
    const item = raw as Partial<GoalTodoPlanItem>
    if (typeof item.key !== "string" || !item.key.trim() || keys.has(item.key)) return false
    if (typeof item.content !== "string" || !item.content.trim()) return false
    if (typeof item.status !== "string" || !TODO_STATUSES.has(item.status as NativeTodoStatus)) return false
    if (item.priority !== undefined && typeof item.priority !== "string") return false
    if (item.nativeID !== undefined && typeof item.nativeID !== "string") return false
    if (!nonNegativeInteger(item.order) || item.order !== index) return false
    keys.add(item.key)
    if (item.status === "pending") counts.pending += 1
    else if (item.status === "in_progress") counts.inProgress += 1
    else if (item.status === "completed") counts.completed += 1
    else if (item.status === "cancelled") counts.cancelled += 1
  }

  return counts.pending === plan.pending
    && counts.inProgress === plan.inProgress
    && counts.completed === plan.completed
    && counts.cancelled === plan.cancelled
}

function validPlanAnomalies(plan: Partial<GoalTodoPlan>): boolean {
  if (plan.anomalies === undefined) return true
  if (!Array.isArray(plan.anomalies)) return false
  for (const raw of plan.anomalies) {
    if (!raw || typeof raw !== "object") return false
    const anomaly = raw as Partial<GoalTodoPlanAnomaly>
    if (typeof anomaly.kind !== "string" || !TODO_ANOMALY_KINDS.has(anomaly.kind)) return false
    if (typeof anomaly.summary !== "string" || !anomaly.summary.trim()) return false
    if (!Array.isArray(anomaly.itemKeys)) return false
    const keys = new Set<string>()
    for (const key of anomaly.itemKeys) {
      if (typeof key !== "string" || !key.trim() || keys.has(key)) return false
      keys.add(key)
    }
  }
  return true
}

export function validGoalTodoPlan(value: unknown): value is GoalTodoPlan {
  if (!value || typeof value !== "object") return false
  const plan = value as Partial<GoalTodoPlan>
  return nonNegativeInteger(plan.goalRevision)
    && (plan.source === undefined || plan.source === "native" || plan.source === "goal_fallback")
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
    && validManifestItems(plan)
    && validPlanAnomalies(plan)
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

function multipleInProgressAnomaly(items: GoalTodoPlanItem[]): GoalTodoPlanAnomaly | undefined {
  const active = items.filter((item) => item.status === "in_progress")
  if (active.length <= 1) return undefined
  return {
    kind: "multiple_in_progress",
    summary: `${active.length} Todo items are simultaneously in_progress; expected at most one.`,
    itemKeys: active.map((item) => item.key),
  }
}

function transitionAnomalies(previous: GoalTodoPlan | undefined, next: GoalTodoPlan): GoalTodoPlanAnomaly[] {
  if (!previous || previous.goalRevision !== next.goalRevision || !Array.isArray(previous.items) || !Array.isArray(next.items)) return []

  const anomalies: GoalTodoPlanAnomaly[] = []
  const priorCompleted = new Set(previous.items.filter((item) => item.status === "completed").map((item) => item.key))
  for (const anomaly of previous.anomalies ?? []) {
    if (anomaly.kind === "completed_regression") {
      for (const key of anomaly.itemKeys) priorCompleted.add(key)
    }
  }

  const regressed = next.items.filter((item) => priorCompleted.has(item.key) && (item.status === "pending" || item.status === "in_progress"))
  if (regressed.length) {
    anomalies.push({
      kind: "completed_regression",
      summary: `${regressed.length} previously completed Todo item(s) regressed to pending/in_progress in the same Goal revision.`,
      itemKeys: regressed.map((item) => item.key),
    })
  }

  if (previous.items.length >= 4 && next.items.length >= 4) {
    const previousKeys = new Set(previous.items.map((item) => item.key))
    const nextKeys = new Set(next.items.map((item) => item.key))
    const shared = previous.items.filter((item) => nextKeys.has(item.key)).map((item) => item.key)
    const removed = previous.items.filter((item) => !nextKeys.has(item.key)).map((item) => item.key)
    const added = next.items.filter((item) => !previousKeys.has(item.key)).map((item) => item.key)
    const baseline = Math.max(previous.items.length, next.items.length)
    if (
      shared.length / baseline < 0.5
      && removed.length >= Math.ceil(previous.items.length / 2)
      && added.length >= Math.ceil(next.items.length / 2)
    ) {
      anomalies.push({
        kind: "substantial_replacement",
        summary: `Todo plan changed substantially in the same Goal revision: ${removed.length} removed, ${added.length} added, ${shared.length} retained.`,
        itemKeys: [...new Set([...removed, ...added])],
      })
    }
  }

  return anomalies
}

export function summarizeTodoPlan(
  goalRevision: number,
  todos: NativeTodoItem[],
  observedAt = Date.now(),
  source: GoalTodoPlanSource = "native",
): GoalTodoPlan {
  const canonical = todos.map((item) => ({
    content: item.content,
    status: item.status,
    priority: item.priority ?? "",
  }))
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`
  const items = manifestItems(todos)
  const multipleInProgress = multipleInProgressAnomaly(items)
  return {
    goalRevision,
    source,
    digest,
    total: todos.length,
    pending: todos.filter((item) => item.status === "pending").length,
    inProgress: todos.filter((item) => item.status === "in_progress").length,
    completed: todos.filter((item) => item.status === "completed").length,
    cancelled: todos.filter((item) => item.status === "cancelled").length,
    observedAt,
    items,
    ...(multipleInProgress ? { anomalies: [multipleInProgress] } : {}),
  }
}

export function observeTodoPlan(
  goal: GoalState,
  todos: NativeTodoItem[],
  observedAt = Date.now(),
  source: GoalTodoPlanSource = "native",
): GoalState {
  let next = summarizeTodoPlan(goal.revision, todos, observedAt, source)
  const previous = validGoalTodoPlan(goal.todoPlan) ? goal.todoPlan : undefined
  const previousSource: GoalTodoPlanSource | undefined = previous
    ? (previous.source ?? "native")
    : undefined

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
    && Array.isArray(previous.items)
  ) {
    if (previousSource === source) return goal
    // Native host state outranks the Goal fallback. Do not downgrade an
    // already observed native plan merely because the fallback tool repeats it.
    if (previousSource === "native" && source === "goal_fallback") return goal
  }

  const anomalies = [...(next.anomalies ?? []), ...transitionAnomalies(previous, next)]
  if (anomalies.length) next = { ...next, anomalies }

  return {
    ...goal,
    todoPlan: next,
    updatedAt: observedAt,
  }
}

export function todoPlanSource(goal: GoalState): GoalTodoPlanSource | undefined {
  const plan = validGoalTodoPlan(goal.todoPlan) ? goal.todoPlan : undefined
  return plan ? (plan.source ?? "native") : undefined
}

export function todoPlanSourceLabel(goal: GoalState): string {
  const source = todoPlanSource(goal)
  if (source === "goal_fallback") return "OpenCode Goal fallback Todo plan"
  return "Native OpenCode Todo plan"
}

export function todoPlanIsCurrent(goal: GoalState): boolean {
  return validGoalTodoPlan(goal.todoPlan) && goal.todoPlan.goalRevision === goal.revision
}

export function todoManifestIsCurrent(goal: GoalState): boolean {
  return todoPlanIsCurrent(goal) && Array.isArray(goal.todoPlan?.items)
}

export function formatTodoPlan(goal: GoalState): string {
  const plan = validGoalTodoPlan(goal.todoPlan) ? goal.todoPlan : undefined
  if (!plan) return goal.todoPlan === undefined ? "not observed" : "invalid advisory telemetry ignored"
  const freshness = plan.goalRevision === goal.revision ? `current r${plan.goalRevision}` : `STALE r${plan.goalRevision}`
  const manifest = Array.isArray(plan.items) ? `; durable manifest ${plan.items.length} items` : "; legacy aggregate only"
  const anomaly = plan.anomalies?.length ? `; WARNING ${plan.anomalies.map((item) => item.summary).join(" | ")}` : ""
  return `${freshness}; ${plan.total} total (${plan.pending} pending, ${plan.inProgress} in progress, ${plan.completed} completed, ${plan.cancelled} cancelled)${manifest}${anomaly}`
}

export function formatTodoManifest(goal: GoalState, maxChars = TODO_MANIFEST_CONTEXT_MAX_CHARS): string {
  const plan = validGoalTodoPlan(goal.todoPlan) ? goal.todoPlan : undefined
  if (!plan) return goal.todoPlan === undefined ? "Todo manifest not observed." : "Todo manifest invalid; advisory telemetry ignored."
  const freshness = plan.goalRevision === goal.revision ? `current r${plan.goalRevision}` : `STALE r${plan.goalRevision}`
  if (!Array.isArray(plan.items)) return `Todo manifest ${freshness}: unavailable in legacy aggregate-only telemetry.`
  if (!plan.items.length) return `Todo manifest ${freshness}: empty.`

  const limit = Number.isFinite(maxChars) ? Math.max(256, Math.floor(maxChars)) : TODO_MANIFEST_CONTEXT_MAX_CHARS
  let output = `Todo manifest ${freshness}; ${plan.items.length} items (advisory planning state, never completion evidence):`
  if (plan.anomalies?.length) output += `\nTodo drift WARNING: ${plan.anomalies.map((item) => item.summary).join(" | ")}`
  for (const [index, item] of plan.items.entries()) {
    const priority = item.priority ? `; priority=${item.priority}` : ""
    const line = `\n${index + 1}. [${item.status}] ${item.content}${priority}`
    if (output.length + line.length > limit) {
      output += `\n… ${plan.items.length - index} more item(s) retained durably in Goal state; omitted here to bound model context.`
      break
    }
    output += line
  }
  return output
}
