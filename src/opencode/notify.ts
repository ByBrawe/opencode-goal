import { spawn } from "node:child_process"
import type { GoalState } from "../domain/types.js"
import type { GoalStoreTransitionReason } from "../persistence/store.js"

export type GoalNotifyReason = GoalStoreTransitionReason | "rejected"

export interface GoalNotifyOptions {
  /** Test seam: overrides node:child_process.spawn for the fire-and-forget runner. */
  spawn?: typeof spawn
}

const NOTIFY_TIMEOUT_MS = 60_000

/**
 * Mirror OpenCode Loop's `--notify` substitution exactly: `{reason}` first,
 * then `{goal}` with the Goal id. Matching Loop keeps one shared command
 * template usable for both plugins.
 */
export function formatGoalNotifyCommand(template: string, goalID: string, reason: GoalNotifyReason): string {
  return String(template).replace(/\{reason\}/g, reason).replace(/\{goal\}/g, goalID)
}

/**
 * Run the Goal's notify command in the project directory via a shell,
 * fire-and-forget, with a bounded kill timer. Delivery failures, hangs, and
 * missing commands are intentionally invisible to Goal state: no result is
 * read back and nothing here can throw into save(), completion, or execute().
 */
export function notifyGoal(
  directory: string,
  goal: Pick<GoalState, "id" | "notifyCommand">,
  reason: GoalNotifyReason,
  options: GoalNotifyOptions = {},
): void {
  if (!goal.notifyCommand) return
  try {
    const child = (options.spawn ?? spawn)(formatGoalNotifyCommand(goal.notifyCommand, goal.id, reason), {
      cwd: directory,
      shell: true,
      detached: true,
      stdio: "ignore",
    })
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // The command may have exited between the timeout and the kill.
      }
    }, NOTIFY_TIMEOUT_MS)
    timer.unref?.()
    child.on("error", () => clearTimeout(timer))
    child.on("exit", () => clearTimeout(timer))
    child.unref()
  } catch {
    // A notify command must never affect the Goal, its completion, or its persistence.
  }
}

export function createGoalTransitionNotifier(
  directory: string,
  options: GoalNotifyOptions = {},
): (goal: GoalState, reason: GoalStoreTransitionReason) => void {
  return (goal, reason) => notifyGoal(directory, goal, reason, options)
}

/**
 * Classify a completion attempt for notification. A failed audit leaves the
 * Goal active; only that case is the explicit `rejected` signal. Successful
 * audits are announced by the store transition sink as `completed`.
 */
export function completionNotificationReason(goal: GoalState, audit: { ok: boolean }): GoalNotifyReason | undefined {
  if (audit.ok || goal.status !== "active") return undefined
  return "rejected"
}
