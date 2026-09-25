import type { GoalState } from "../domain/types.js"
import {
  fatalProviderReason,
  pauseForFatalProviderError,
  providerPromptOverflowReason,
  type HostSessionError,
} from "../runtime/limits.js"
import {
  enterInfrastructureRecovery,
  isTransientInfrastructureError,
} from "../runtime/infrastructure-recovery.js"

export interface OpenCode2HostLimitRuntime {
  successEpochBySession: Map<string, number>
  compactionReasonBySession: Map<string, string>
  compactionAttemptBySession: Map<string, {
    goalID: string
    revision: number
    successEpoch: number
  }>
}

export type OpenCode2FailureDisposition =
  | { kind: "overflow"; reason: string; goal: GoalState }
  | { kind: "transient"; reason: string; goal: GoalState }
  | { kind: "fatal"; reason: string; goal: GoalState }
  | { kind: "ignore"; goal: GoalState }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function numeric(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function createOpenCode2HostLimitRuntime(): OpenCode2HostLimitRuntime {
  return {
    successEpochBySession: new Map(),
    compactionReasonBySession: new Map(),
    compactionAttemptBySession: new Map(),
  }
}

export function clearOpenCode2HostLimitSession(
  runtime: OpenCode2HostLimitRuntime,
  sessionID: string,
): void {
  runtime.successEpochBySession.delete(sessionID)
  runtime.compactionReasonBySession.delete(sessionID)
  runtime.compactionAttemptBySession.delete(sessionID)
}

export function markOpenCode2OwnedExecutionSuccess(
  runtime: OpenCode2HostLimitRuntime,
  sessionID: string,
): void {
  runtime.successEpochBySession.set(
    sessionID,
    (runtime.successEpochBySession.get(sessionID) ?? 0) + 1,
  )
  runtime.compactionAttemptBySession.delete(sessionID)
}

export function observeOpenCode2CompactionReason(
  runtime: OpenCode2HostLimitRuntime,
  sessionID: string,
  event: unknown,
): void {
  const item = record(event)
  const type = firstString(item?.type)
  if (type !== "session.compaction.started" && type !== "session.compaction.ended") return
  const data = record(item?.data)
  const properties = record(item?.properties)
  const reason = firstString(data?.reason, properties?.reason)
  if (reason) runtime.compactionReasonBySession.set(sessionID, reason)
}

export function consumeOpenCode2CompactionReason(
  runtime: OpenCode2HostLimitRuntime,
  sessionID: string,
): string | undefined {
  const reason = runtime.compactionReasonBySession.get(sessionID)
  runtime.compactionReasonBySession.delete(sessionID)
  return reason
}

export function observeOpenCode2NativeCompaction(
  runtime: OpenCode2HostLimitRuntime,
  goal: GoalState,
): { repeatedWithoutOwnedSuccess: boolean } {
  const sessionID = goal.sessionID
  const successEpoch = runtime.successEpochBySession.get(sessionID) ?? 0
  const previous = runtime.compactionAttemptBySession.get(sessionID)
  const repeatedWithoutOwnedSuccess = Boolean(
    previous
    && previous.goalID === goal.id
    && previous.revision === goal.revision
    && previous.successEpoch === successEpoch
  )

  runtime.compactionAttemptBySession.set(sessionID, {
    goalID: goal.id,
    revision: goal.revision,
    successEpoch,
  })
  return { repeatedWithoutOwnedSuccess }
}

export function repeatedOpenCode2CompactionReason(): string {
  return "OpenCode auto-compacted the same Goal revision again before any successful Goal-owned execution completed. Goal state is preserved to prevent an unbounded compaction/continuation loop. Run /compact if needed, then /goal resume."
}

export function normalizeOpenCode2ProviderFailure(error: unknown): HostSessionError {
  const item = record(error)
  const type = firstString(item?.type)
  const status = numeric(item?.status)
  const message = firstString(item?.message) ?? JSON.stringify(error)
  const providerID = firstString(item?.providerID, record(item?.data)?.providerID)
  const signature = (type ?? "") + " " + message
  const retryable = status === 408
    || status === 425
    || status === 429
    || (status !== undefined && status >= 500)
    || /retry|rate.?limit|overload|temporar|timeout|network|connection/i.test(signature)

  return {
    name: /auth|credential|unauthori[sz]ed|forbidden/i.test(signature)
      ? "ProviderAuthError"
      : "APIError",
    data: {
      ...(providerID ? { providerID } : {}),
      message,
      ...(status !== undefined ? { statusCode: status } : {}),
      isRetryable: retryable,
    },
  }
}

export function classifyOpenCode2ExecutionFailure(
  goal: GoalState,
  error: unknown,
  now = Date.now(),
): OpenCode2FailureDisposition {
  if (goal.status !== "active") return { kind: "ignore", goal }

  const normalized = normalizeOpenCode2ProviderFailure(error)
  const overflow = providerPromptOverflowReason(normalized, goal)
  if (overflow) {
    return {
      kind: "overflow",
      reason: overflow,
      goal: pauseForFatalProviderError(
        goal,
        overflow + " OpenCode native compaction did not recover this Goal-owned execution. Goal state is preserved. Run /compact, then /goal resume.",
        now,
      ),
    }
  }

  if (isTransientInfrastructureError(normalized)) {
    const reason = normalized.data?.message ?? "Transient provider failure"
    return {
      kind: "transient",
      reason,
      goal: enterInfrastructureRecovery(goal, {
        kind: "provider_retry",
        reason,
        now,
      }),
    }
  }

  const fatal = fatalProviderReason(normalized)
  if (fatal) {
    return {
      kind: "fatal",
      reason: fatal,
      goal: pauseForFatalProviderError(goal, fatal, now),
    }
  }

  return { kind: "ignore", goal }
}
