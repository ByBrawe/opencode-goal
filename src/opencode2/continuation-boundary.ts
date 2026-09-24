import type { GoalState } from "../domain/types.js"
import { continuationPrompt } from "../opencode/prompt.js"
import {
  settleGoalForOpenCode2ExecutionEvent,
  type OpenCode2ExecutionTerminal,
} from "./execution-boundary.js"

export interface OpenCode2ContinuationPreparation {
  goal: GoalState
  terminal?: OpenCode2ExecutionTerminal
  closed: boolean
  shouldContinue: boolean
  prompt?: string
}

export function prepareOpenCode2Continuation(
  goal: GoalState,
  event: unknown,
  input: { maxStalledTurns?: number; now?: number } = {},
): OpenCode2ContinuationPreparation {
  const settled = settleGoalForOpenCode2ExecutionEvent(goal, event, input)
  if (!settled.closed || settled.goal.status !== "active") {
    return {
      goal: settled.goal,
      ...(settled.terminal ? { terminal: settled.terminal } : {}),
      closed: settled.closed,
      shouldContinue: false,
    }
  }

  return {
    goal: settled.goal,
    terminal: "succeeded",
    closed: true,
    shouldContinue: true,
    prompt: continuationPrompt(settled.goal),
  }
}
