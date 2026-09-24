import type { GoalBudget, GoalState } from "../domain/types.js"
import type { ParsedGoalCommand } from "../opencode/command.js"
import {
  formatDetailedGoalStatus,
  formatGoalContract,
  formatGoalDoctor,
  formatGoalHistory,
  formatHistoryPrune,
  formatRestoreResult,
} from "../opencode/controls.js"
import { formatGoalAudit } from "../opencode/audit-ux.js"
import { formatProjectGoalIndex } from "../opencode/project-index.js"
import { formatGoalSequence } from "../opencode/sequence.js"
import { createGoalTransitionNotifier } from "../opencode/notify.js"
import { diagnoseGoalStorage } from "../persistence/diagnostics.js"
import { GoalSequenceStore } from "../persistence/sequence-store.js"
import { GoalStore } from "../persistence/store.js"
import { applyGoalBudget } from "../runtime/accounting.js"

export type OpenCode2ControlPlaneResult = {
  goal: GoalState | null
  message: string
  kickoff: boolean
}

export const OPENCODE2_READ_CONTROL_ACTIONS = new Set<ParsedGoalCommand["action"]>([
  "status",
  "contract",
  "audit",
  "history",
  "doctor",
  "list",
  "queue",
])

export const OPENCODE2_EXTRA_MUTATION_ACTIONS = new Set<ParsedGoalCommand["action"]>([
  "budget",
  "history_prune",
  "restore",
  "add",
  "queue_remove",
  "queue_move",
  "queue_clear",
  "next",
])

function budgetPatch(parsed: ParsedGoalCommand): Partial<GoalBudget> {
  return {
    ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    ...(parsed.maxRuntimeMs !== undefined ? { maxRuntimeMs: parsed.maxRuntimeMs } : {}),
    ...(parsed.maxCost !== undefined ? { maxCost: parsed.maxCost } : {}),
  }
}

export function hasOpenCode2BudgetPatch(parsed: ParsedGoalCommand): boolean {
  return Object.keys(budgetPatch(parsed)).length > 0
}

function shortID(value: string): string {
  return value.slice(0, 12)
}

function queueFailure(prefix: string, result: { reason: string; matches: any[] }): string {
  if (result.reason === "not_found") return `No queued Goal matches "${prefix}".`
  if (result.reason === "ambiguous") {
    return `Multiple queued Goals match "${prefix}". Use a longer id prefix:\n${result.matches
      .slice(0, 10)
      .map((item: any, index: number) => `${index + 1}. ${shortID(item.id)} [${item.activating ? "activating" : "queued"}] ${item.objective}`)
      .join("\n")}`
  }
  if (result.reason === "position") return "Queue position is outside the current ordered queue."
  return "That queued Goal is currently being activated. Retry after activation settles."
}

export async function readOpenCode2ControlPlane(
  directory: string,
  sessionID: string,
  parsed: ParsedGoalCommand,
): Promise<string | undefined> {
  const store = new GoalStore(directory)

  if (parsed.action === "status") {
    return formatDetailedGoalStatus(await store.load(sessionID))
  }
  if (parsed.action === "contract") {
    return formatGoalContract(await store.load(sessionID))
  }
  if (parsed.action === "audit") {
    return formatGoalAudit(await store.load(sessionID))
  }
  if (parsed.action === "history") {
    return formatGoalHistory(await store.history(sessionID, 500), parsed.goalIDPrefix)
  }
  if (parsed.action === "doctor") {
    return formatGoalDoctor(await diagnoseGoalStorage(directory, sessionID))
  }
  if (parsed.action === "list") {
    return formatProjectGoalIndex(await store.list(), sessionID, parsed.goalIDPrefix)
  }
  if (parsed.action === "queue") {
    const sequence = new GoalSequenceStore(directory)
    return formatGoalSequence(await store.load(sessionID), await sequence.load(sessionID))
  }
  if (parsed.action === "budget" && !hasOpenCode2BudgetPatch(parsed)) {
    return formatDetailedGoalStatus(await store.load(sessionID))
  }
  return undefined
}

export async function applyOpenCode2ControlPlaneMutation(
  directory: string,
  sessionID: string,
  parsed: ParsedGoalCommand,
): Promise<OpenCode2ControlPlaneResult | undefined> {
  const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })

  if (parsed.action === "budget") {
    const goal = await store.load(sessionID)
    if (!goal) return { goal: null, message: "No active goal.", kickoff: false }
    const patch = budgetPatch(parsed)
    if (!Object.keys(patch).length) {
      return { goal, message: formatDetailedGoalStatus(goal), kickoff: false }
    }
    const beforeStatus = goal.status
    const next = applyGoalBudget(goal, patch)
    await store.save(next)
    return {
      goal: next,
      message: `Goal budget updated.\n${formatDetailedGoalStatus(next)}`,
      kickoff: beforeStatus === "budget_limited" && next.status === "active",
    }
  }

  if (parsed.action === "history_prune") {
    const result = await store.pruneHistory(sessionID, parsed.historyKeep!)
    return {
      goal: await store.load(sessionID),
      message: formatHistoryPrune(result),
      kickoff: false,
    }
  }

  if (parsed.action === "restore") {
    const result = await store.restore(sessionID, parsed.goalIDPrefix!)
    return {
      goal: result.ok ? result.goal : await store.load(sessionID),
      message: formatRestoreResult(result, parsed.goalIDPrefix!),
      kickoff: false,
    }
  }

  const sequence = new GoalSequenceStore(directory)

  if (parsed.action === "add") {
    if (!parsed.objective) throw new Error("Usage: /goal add <objective> [Goal Contract options]")
    const result = await sequence.enqueue(sessionID, {
      objective: parsed.objective,
      acceptance: parsed.acceptance,
      constraints: parsed.constraints,
      checks: parsed.checks,
      files: parsed.files,
      ...(parsed.notifyCommand ? { notifyCommand: parsed.notifyCommand } : {}),
      budget: budgetPatch(parsed),
    })
    return {
      goal: await store.load(sessionID),
      message: `Queued Goal ${shortID(result.item.id)} at position ${result.sequence.items.length}: ${result.item.objective}\nPending Goals: ${result.sequence.items.length}`,
      kickoff: false,
    }
  }

  if (parsed.action === "queue_remove") {
    const result = await sequence.remove(sessionID, parsed.goalIDPrefix!)
    return {
      goal: await store.load(sessionID),
      message: result.ok
        ? `Removed queued Goal ${shortID(result.item.id)}: ${result.item.objective}\nPending Goals: ${result.sequence.items.length}`
        : queueFailure(parsed.goalIDPrefix!, result),
      kickoff: false,
    }
  }

  if (parsed.action === "queue_move") {
    const result = await sequence.move(sessionID, parsed.goalIDPrefix!, parsed.queuePosition!)
    return {
      goal: await store.load(sessionID),
      message: result.ok
        ? `Moved queued Goal ${shortID(result.item.id)} to position ${result.position}.\n${formatGoalSequence(await store.load(sessionID), result.sequence)}`
        : queueFailure(parsed.goalIDPrefix!, result),
      kickoff: false,
    }
  }

  if (parsed.action === "queue_clear") {
    const result = await sequence.clear(sessionID)
    return {
      goal: await store.load(sessionID),
      message: result.ok
        ? `Cleared ${result.removed.length} queued Goal(s). The current live Goal was not changed.`
        : "Cannot clear the queue while its head Goal is being activated. Retry after activation settles.",
      kickoff: false,
    }
  }

  if (parsed.action === "next") {
    const result = await sequence.promoteNext(sessionID)
    if (result.ok) {
      return {
        goal: result.goal,
        message: `Activated queued Goal ${shortID(result.goal.id)}: ${result.goal.objective}`,
        kickoff: result.goal.status === "active",
      }
    }
    if (result.reason === "empty") {
      return { goal: await store.load(sessionID), message: "Goal queue is empty. Nothing was activated.", kickoff: false }
    }
    return {
      goal: result.current,
      message: `Cannot activate the next queued Goal while an unfinished Goal is current.\nCurrent: ${shortID(result.current.id)} [${result.current.status}] ${result.current.objective}`,
      kickoff: false,
    }
  }

  return undefined
}
