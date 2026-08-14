export const DEFAULT_SEMANTIC_VERIFIER_TIMEOUT_MS = 5 * 60_000

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/**
 * Keep semantic verification independent from long-running build/check timeouts.
 *
 * The core verifier still accepts an explicit plugin option and the existing
 * OPENCODE_GOAL_VERIFIER_TIMEOUT_MS environment override. We inject a more
 * realistic default only when neither override is configured.
 */
export function applySemanticVerifierTimeoutDefault<T extends { verifierTimeoutMs?: number }>(options: T): T {
  if (positiveNumber(options.verifierTimeoutMs) !== undefined) return options
  if (positiveNumber(process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS) !== undefined) return options
  return { ...options, verifierTimeoutMs: DEFAULT_SEMANTIC_VERIFIER_TIMEOUT_MS }
}
