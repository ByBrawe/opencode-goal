import type { GoalState } from "../domain/types.js"
import { budgetLimitHits } from "../runtime/accounting.js"
import { isRestrictedGoalAgent } from "../opencode/agent-boundary.js"
import { continuationPrompt } from "../opencode/prompt.js"

export type OpenCode2RestartBlockReason =
  | "inactive"
  | "restricted-agent"
  | "budget-reached"
  | "infrastructure-recovery"

export interface OpenCode2RestartPreparation {
  goal: GoalState
  shouldContinue: boolean
  prompt?: string
  blockedBy?: OpenCode2RestartBlockReason
}

export function prepareOpenCode2RestartContinuation(
  goal: GoalState,
  input: { now?: number } = {},
): OpenCode2RestartPreparation {
  const now = input.now ?? Date.now()

  if (goal.status !== "active") {
    return { goal, shouldContinue: false, blockedBy: "inactive" }
  }

  if (isRestrictedGoalAgent(goal.execution?.agent)) {
    return { goal, shouldContinue: false, blockedBy: "restricted-agent" }
  }

  if (budgetLimitHits(goal.usage, goal.budget).length > 0) {
    return { goal, shouldContinue: false, blockedBy: "budget-reached" }
  }

  if (
    goal.infrastructureRecovery
    && goal.infrastructureRecovery.nextRetryAt > now
  ) {
    return { goal, shouldContinue: false, blockedBy: "infrastructure-recovery" }
  }

  return {
    goal,
    shouldContinue: true,
    prompt: continuationPrompt(goal),
  }
}
