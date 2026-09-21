import { spawn } from "node:child_process"
import type { GoalState } from "../domain/types.js"
import type { GoalStoreTransitionReason } from "../persistence/store.js"

export type GoalNotifyReason = GoalStoreTransitionReason | "rejected"

export interface GoalNotifyOptions {
  spawn?: typeof spawn
}

const NOTIFY_TIMEOUT_MS = 60_000

export function formatGoalNotifyCommand(template: string, goalID: string, reason: GoalNotifyReason): string {
  return String(template).replace(/\{reason\}/g, reason).replace(/\{goal\}/g, goalID)
}

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
      try { child.kill("SIGTERM") } catch {}
    }, NOTIFY_TIMEOUT_MS)
    timer.unref?.()
    child.on("error", () => clearTimeout(timer))
    child.on("exit", () => clearTimeout(timer))
    child.unref()
  } catch {
    // Notification delivery is advisory and must never affect Goal state.
  }
}

export function createGoalTransitionNotifier(
  directory: string,
  options: GoalNotifyOptions = {},
): (goal: GoalState, reason: GoalStoreTransitionReason) => void {
  return (goal, reason) => notifyGoal(directory, goal, reason, options)
}

export function completionNotificationReason(
  goal: GoalState,
  audit: { ok: boolean },
): GoalNotifyReason | undefined {
  if (audit.ok || goal.status !== "active") return undefined
  return "rejected"
}
