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
  if (goal.pendingContinuation && goal.usage.turns === 0) {
    const { pendingContinuation: _pendingContinuation, ...rest } = goal
    return { ...rest, observedProgressRevision: goal.progressRevision, updatedAt: now }
  }
  const { pendingContinuation: _pendingContinuation, ...settled } = goal
  const limit = Math.max(1, input.maxStalledTurns ?? 3)
  const madeProgress = settled.progressRevision > settled.observedProgressRevision
  const stalledTurns = madeProgress ? 0 : settled.stalledTurns + 1
  const paused = stalledTurns >= limit && settled.status === "active"
  return {
    ...settled,
    stalledTurns,
    observedProgressRevision: settled.progressRevision,
    ...(paused ? { status: "paused" as const, stopReason: `Paused after ${stalledTurns} continuation turns without host-observed progress.` } : {}),
    updatedAt: now,
  }
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
