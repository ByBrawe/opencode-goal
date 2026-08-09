import { pauseGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"

const USAGE_LIMIT_REASONS = new Set(["free_tier_limit", "account_rate_limit"])

export interface HostRetryStatus {
  type?: string
  action?: {
    reason?: string
    provider?: string
    title?: string
    message?: string
    label?: string
    link?: string
  }
}

export interface HostSessionError {
  name?: string
  data?: {
    providerID?: string
    message?: string
    statusCode?: number
    isRetryable?: boolean
  }
}

function concise(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

export function hostUsageLimitReason(status: HostRetryStatus): string | undefined {
  if (status?.type !== "retry") return undefined
  const action = status.action
  if (!action || !USAGE_LIMIT_REASONS.has(String(action.reason ?? ""))) return undefined
  const provider = concise(action.provider, 80)
  const title = concise(action.title, 120) || "Usage limit reached"
  const message = concise(action.message, 360)
  const detail = message && message !== title ? `${title}: ${message}` : title
  return `OpenCode provider usage limit${provider ? ` (${provider})` : ""}: ${detail}`
}

export function markUsageLimited(goal: GoalState, reason: string, now = Date.now()): GoalState {
  if (goal.status !== "active") return goal
  return { ...goal, status: "usage_limited", stopReason: concise(reason), updatedAt: now }
}

export function fatalProviderReason(error: HostSessionError): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const name = String(error.name ?? "")
  const data = error.data ?? {}
  const message = concise(data.message, 360) || "Provider request failed"

  if (name === "ProviderAuthError") {
    const provider = concise(data.providerID, 80)
    return `Provider authentication failed${provider ? ` (${provider})` : ""}: ${message}`
  }

  if (name !== "APIError" || data.isRetryable !== false) return undefined
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  if (status !== undefined && (status === 408 || status === 425 || status === 429 || status >= 500)) return undefined
  return `Provider request failed${status !== undefined ? ` (HTTP ${status})` : ""}: ${message}`
}

export function pauseForFatalProviderError(goal: GoalState, reason: string, now = Date.now()): GoalState {
  if (goal.status !== "active") return goal
  return pauseGoal(goal, concise(reason), now)
}
