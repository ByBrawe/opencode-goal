import { pauseGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"

const USAGE_LIMIT_REASONS = new Set(["free_tier_limit", "account_rate_limit"])

const PROMPT_OVERFLOW_PATTERNS = [
  /prompt exceeds max(?:imum)? length/i,
  /prompt (?:is )?too (?:long|large)/i,
  /prompt (?:length|tokens?|token count).*?(?:exceed|over).*?(?:limit|maximum|max)/i,
  /(?:maximum|max) context (?:length|window).*?(?:exceed|reached|too (?:long|large))/i,
  /context (?:length|window).*?(?:exceed|overflow|too (?:long|large))/i,
  /context[_ -]?length[_ -]?exceeded/i,
  /context overflow/i,
  /input length.*max_tokens.*context/i,
]

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

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function isProviderPromptOverflowError(value: unknown): boolean {
  const text = errorText(value)
  return PROMPT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}

export function providerPromptOverflowReason(value: unknown): string | undefined {
  if (!isProviderPromptOverflowError(value)) return undefined
  const error = value && typeof value === "object" ? value as HostSessionError : undefined
  const data = error?.data ?? {}
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  const provider = concise(data.providerID, 80)
  const message = concise(data.message, 360) || concise(errorText(value), 360) || "Prompt exceeds the provider context limit"
  return `Provider prompt/context limit${provider ? ` (${provider})` : ""}${status !== undefined ? ` HTTP ${status}` : ""}: ${message}`
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

export function markPromptOverflowRecovering(goal: GoalState, reason: string, now = Date.now()): GoalState {
  if (goal.status !== "active") return goal
  const { infrastructureRecovery: _infrastructureRecovery, skipNextStallCheck: _skipNextStallCheck, ...rest } = goal
  return {
    ...rest,
    status: "active",
    stopReason: `Recovering from provider prompt/context limit with one OpenCode compaction attempt. ${concise(reason)}`,
    skipNextStallCheck: true,
    updatedAt: now,
  }
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
  const paused = pauseGoal(goal, concise(reason), now)
  const { infrastructureRecovery: _infrastructureRecovery, skipNextStallCheck: _skipNextStallCheck, ...rest } = paused
  return rest
}
