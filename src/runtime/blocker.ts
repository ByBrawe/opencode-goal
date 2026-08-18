import { createHash } from "node:crypto"
import type { GoalState } from "../domain/types.js"

function fingerprint(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 24)
}

export function reportBlocker(goal: GoalState, input: {
  turnID: string
  reason: string
  needed?: string
  key?: string
  threshold?: number
  now?: number
}): GoalState {
  const now = input.now ?? Date.now()
  const threshold = Math.max(1, input.threshold ?? 3)
  const reason = input.reason.trim()
  const needed = (input.needed ?? "").trim()
  if (!reason) throw new Error("blocker reason must not be empty")
  const nextFingerprint = fingerprint(input.key?.trim() || reason)
  const previous = goal.blockerAudit
  const same = previous?.fingerprint === nextFingerprint
  const sameTurn = same && previous?.lastTurnID === input.turnID
  const consecutiveTurns = same ? (sameTurn ? previous.consecutiveTurns : previous.consecutiveTurns + 1) : 1
  const status = consecutiveTurns >= threshold ? "blocked" as const : "active" as const
  const repeatedOnNewTurn = same && !sameTurn && consecutiveTurns > 1
  return {
    ...goal,
    status,
    blockerAudit: { fingerprint: nextFingerprint, consecutiveTurns, lastTurnID: input.turnID, reason, needed },
    // A second distinct report of the same blocker is progress toward the
    // dedicated three-turn blocker circuit breaker. Reset only the generic
    // stall counter here so it cannot preempt the third blocker turn. A new
    // or changing blocker key does not get this exemption.
    stalledTurns: repeatedOnNewTurn ? 0 : goal.stalledTurns,
    ...(status === "blocked" ? { stopReason: reason } : {}),
    updatedAt: now,
  }
}
