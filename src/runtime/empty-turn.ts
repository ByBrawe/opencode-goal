import type { GoalState } from "../domain/types.js"
import { accountAssistantUsage, type AssistantUsageSample } from "./accounting.js"

export const DEFAULT_MAX_EMPTY_TURNS = 2

const MEANINGFUL_PART_TYPES = new Set(["tool", "file", "patch", "artifact"])

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

export function assistantPartHasMeaningfulActivity(part: any): boolean {
  if (!part || typeof part !== "object") return false
  if (part.type === "text") return nonEmpty(part.text)
  return MEANINGFUL_PART_TYPES.has(String(part.type ?? ""))
}

export function assistantInfoHasMeaningfulActivity(info: any): boolean {
  if (!info || typeof info !== "object") return false
  return nonEmpty(info.text)
    || nonEmpty(info.content)
    || (typeof info.summary === "string" && nonEmpty(info.summary))
}

export function clearEmptyAssistantTurnStreak(goal: GoalState): GoalState {
  if (!goal.emptyTurnCount && goal.lastEmptyTurnAt === undefined) return goal
  const { emptyTurnCount: _emptyTurnCount, lastEmptyTurnAt: _lastEmptyTurnAt, ...rest } = goal
  return { ...rest }
}

export function recordEmptyAssistantTurn(
  goal: GoalState,
  sample: AssistantUsageSample,
  input: { now?: number; maxEmptyTurns?: number } = {},
): GoalState {
  const now = input.now ?? Date.now()
  if (!sample.messageID || goal.usage.seenMessageIDs.includes(sample.messageID)) return goal

  // Empty assistant requests still cost tokens/money/runtime. Preserve that
  // accounting while refunding only the logical Goal-turn count.
  const accounted = accountAssistantUsage(goal, sample, now, { countTurn: false })
  const count = (goal.emptyTurnCount ?? 0) + 1
  const limit = Math.max(1, Math.floor(input.maxEmptyTurns ?? DEFAULT_MAX_EMPTY_TURNS))
  if (count >= limit) {
    const { skipNextStallCheck: _skipNextStallCheck, ...rest } = accounted
    return {
      ...rest,
      emptyTurnCount: count,
      lastEmptyTurnAt: now,
      status: "paused",
      stopReason: `Paused after ${count} consecutive Goal-owned assistant turns completed without meaningful text or tool/file/patch/artifact activity.`,
      updatedAt: now,
    }
  }

  return {
    ...accounted,
    emptyTurnCount: count,
    lastEmptyTurnAt: now,
    // The next session.idle closes this empty attempt. Exempt it from the
    // generic no-progress counter so the dedicated bounded retry owns policy.
    skipNextStallCheck: true,
    updatedAt: now,
  }
}
