import type {
  GoalInfrastructureRecoveryKind,
  GoalState,
} from "../domain/types.js"

export const DEFAULT_INFRASTRUCTURE_RETRY_BASE_MS = 15_000
export const DEFAULT_INFRASTRUCTURE_RETRY_MAX_MS = 5 * 60_000

const TRANSIENT_PATTERNS = [
  /\b(?:408|425|429|500|502|503|504|524)\b/i,
  /rate[\s_-]?limit|too many requests|overloaded|service[\s_-]?unavailable|provider returned error/i,
  /terminated|fetch failed|failed to fetch|network[\s_-]?error|network connection lost/i,
  /connection (?:error|refused|lost)|socket (?:hang up|connection was closed)|reset before headers/i,
  /\b(?:enotfound|eai_again|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|epipe)\b/i,
  /\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /\btimeout(?:error)?\b/i,
  /temporar(?:y|ily)|try (?:your request )?again/i,
]

const LEGACY_VERIFIER_PREFIX = "Independent semantic verification unavailable:"

function textOf(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function isTransientInfrastructureError(value: unknown): boolean {
  const text = textOf(value)
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))
}

export function infrastructureRetryDelayMs(
  attempt: number,
  baseMs = DEFAULT_INFRASTRUCTURE_RETRY_BASE_MS,
  maxMs = DEFAULT_INFRASTRUCTURE_RETRY_MAX_MS,
): number {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1))
  const safeBase = Math.max(1, Math.floor(Number(baseMs) || DEFAULT_INFRASTRUCTURE_RETRY_BASE_MS))
  const safeMax = Math.max(safeBase, Math.floor(Number(maxMs) || DEFAULT_INFRASTRUCTURE_RETRY_MAX_MS))
  return Math.min(safeMax, safeBase * (2 ** Math.min(10, safeAttempt - 1)))
}

export function enterInfrastructureRecovery(
  goal: GoalState,
  input: {
    kind: GoalInfrastructureRecoveryKind
    reason: string
    now?: number
    baseMs?: number
    maxMs?: number
  },
): GoalState {
  const now = input.now ?? Date.now()
  const previous = goal.infrastructureRecovery
  const attempt = previous?.kind === input.kind ? previous.attempt + 1 : 1
  const delay = infrastructureRetryDelayMs(attempt, input.baseMs, input.maxMs)
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 1000)
  return {
    ...goal,
    status: "active",
    stopReason: `Recovering from ${input.kind} infrastructure failure; automatic retry scheduled. ${reason}`.trim(),
    infrastructureRecovery: {
      kind: input.kind,
      reason,
      attempt,
      startedAt: previous?.kind === input.kind ? previous.startedAt : now,
      nextRetryAt: now + delay,
    },
    // The failed verifier/provider/transport turn is infrastructure, not proof
    // that the coding agent made no progress. Consume this on the next wake-up.
    skipNextStallCheck: true,
    updatedAt: now,
  }
}

export function markInfrastructureRecoveryDispatched(goal: GoalState, now = Date.now()): GoalState {
  if (!goal.infrastructureRecovery) return goal
  return {
    ...goal,
    infrastructureRecovery: {
      ...goal.infrastructureRecovery,
      nextRetryAt: 0,
    },
    skipNextStallCheck: true,
    updatedAt: now,
  }
}

export function clearInfrastructureRecovery(goal: GoalState, now = Date.now()): GoalState {
  if (!goal.infrastructureRecovery && !goal.skipNextStallCheck) return goal
  const { infrastructureRecovery: _infrastructureRecovery, skipNextStallCheck: _skipNextStallCheck, ...rest } = goal
  return { ...rest, updatedAt: now }
}

export function legacyInfrastructureRecovery(goal: GoalState): {
  kind: GoalInfrastructureRecoveryKind
  reason: string
} | undefined {
  const stopReason = String(goal.stopReason ?? "")
  if (goal.status === "paused" && stopReason.startsWith(LEGACY_VERIFIER_PREFIX)) {
    return { kind: "semantic_verifier", reason: stopReason.slice(LEGACY_VERIFIER_PREFIX.length).trim() || stopReason }
  }
  if (goal.status === "paused" && stopReason.startsWith("Continuation dispatch failed:") && isTransientInfrastructureError(stopReason)) {
    return { kind: "continuation_dispatch", reason: stopReason }
  }
  if (
    goal.status === "blocked"
    && /completion-audit infrastructure failure/i.test(stopReason)
    && /semantic verifier|verifier|provider|timeout|timed out|unavailable/i.test(stopReason)
  ) {
    return { kind: "semantic_verifier", reason: stopReason }
  }
  return undefined
}
