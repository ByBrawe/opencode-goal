import type { GoalState } from "../domain/types.js"

export function addProgressNote(goal: GoalState, input: { summary: string; next?: string; now?: number }): GoalState {
  const now = input.now ?? Date.now()
  return {
    ...goal,
    progressNotes: [...goal.progressNotes, { time: now, summary: input.summary.trim(), next: (input.next ?? "").trim() }].slice(-50),
    updatedAt: now,
  }
}

export function closeObservedTurn(goal: GoalState, input: { maxStalledTurns?: number; now?: number } = {}): GoalState {
  const now = input.now ?? Date.now()
  const limit = Math.max(1, input.maxStalledTurns ?? 3)
  const madeProgress = goal.progressRevision > goal.observedProgressRevision
  const stalledTurns = madeProgress ? 0 : goal.stalledTurns + 1
  const paused = stalledTurns >= limit && goal.status === "active"
  return {
    ...goal,
    stalledTurns,
    observedProgressRevision: goal.progressRevision,
    ...(paused ? { status: "paused" as const, stopReason: `Paused after ${stalledTurns} continuation turns without host-observed progress.` } : {}),
    updatedAt: now,
  }
}

export function markHostActivity(goal: GoalState, input: { source: string; summary?: string; now?: number }): GoalState {
  const now = input.now ?? Date.now()
  return {
    ...goal,
    progressRevision: goal.progressRevision + 1,
    progressNotes: input.summary
      ? [...goal.progressNotes, { time: now, summary: `[host:${input.source}] ${input.summary}`, next: "" }].slice(-50)
      : goal.progressNotes,
    updatedAt: now,
  }
}
