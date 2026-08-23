import type { GoalState } from "../domain/types.js"
import { settleReachedGoalBudget } from "./accounting.js"
import { todoPlanIsCurrent } from "./todo-plan.js"

export function addProgressNote(goal: GoalState, input: { summary: string; next?: string; now?: number }): GoalState {
  const now = input.now ?? Date.now()
  return {
    ...goal,
    progressNotes: [...goal.progressNotes, { time: now, summary: input.summary.trim(), next: (input.next ?? "").trim() }].slice(-50),
    updatedAt: now,
  }
}

function defaultStallLimit(goal: GoalState): number {
  if (!todoPlanIsCurrent(goal) || !goal.todoPlan) return 3
  const openItems = goal.todoPlan.pending + goal.todoPlan.inProgress
  if (openItems <= 0) return 3
  // Long native Todo plans naturally contain reconnaissance, verification, and
  // read-only turns that may not create a fresh mutation fingerprint. Keep the
  // guard bounded, but scale its tolerance with remaining plan size.
  return Math.min(12, Math.max(4, 3 + Math.ceil(openItems / 10)))
}

export function closeObservedTurn(goal: GoalState, input: { maxStalledTurns?: number; now?: number } = {}): GoalState {
  const now = input.now ?? Date.now()
  if (goal.pendingContinuation && goal.usage.turns === 0) {
    const { pendingContinuation: _pendingContinuation, skipNextStallCheck: _skipNextStallCheck, ...rest } = goal
    return settleReachedGoalBudget({ ...rest, observedProgressRevision: goal.progressRevision, updatedAt: now }, now)
  }
  const {
    pendingContinuation: _pendingContinuation,
    skipNextStallCheck,
    ...settled
  } = goal
  const limit = Math.max(1, input.maxStalledTurns ?? defaultStallLimit(settled))
  const madeProgress = settled.progressRevision > settled.observedProgressRevision
  // A verifier/provider/transport failure is not an agent no-progress turn.
  // Consume the one-shot exemption without manufacturing a progress fingerprint
  // or resetting legitimate stall history from real assistant turns.
  const stalledTurns = skipNextStallCheck
    ? settled.stalledTurns
    : madeProgress ? 0 : settled.stalledTurns + 1
  const paused = stalledTurns >= limit && settled.status === "active"
  const closed: GoalState = {
    ...settled,
    stalledTurns,
    observedProgressRevision: settled.progressRevision,
    ...(paused ? { status: "paused" as const, stopReason: `Paused after ${stalledTurns} continuation turns without host-observed progress.` } : {}),
    updatedAt: now,
  }
  return settleReachedGoalBudget(closed, now)
}

export function markHostProgress(goal: GoalState, input: {
  fingerprint: string
  source: string
  summary?: string
  now?: number
}): GoalState {
  const fingerprint = input.fingerprint.trim()
  if (!fingerprint) return goal
  const existing = goal.progressFingerprints ?? []
  if (existing.includes(fingerprint)) return goal
  const now = input.now ?? Date.now()
  return {
    ...goal,
    progressRevision: goal.progressRevision + 1,
    progressFingerprints: [...existing, fingerprint].slice(-128),
    progressNotes: input.summary
      ? [...goal.progressNotes, { time: now, summary: `[host:${input.source}] ${input.summary}`, next: "" }].slice(-50)
      : goal.progressNotes,
    updatedAt: now,
  }
}

/** @deprecated Use markHostProgress with a stable host-observed fingerprint. */
export function markHostActivity(goal: GoalState, input: { source: string; summary?: string; now?: number }): GoalState {
  return markHostProgress(goal, {
    fingerprint: `legacy:${input.source}:${goal.progressRevision + 1}`,
    source: input.source,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}
