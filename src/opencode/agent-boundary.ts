import type CorePlugin from "./plugin.js"
import { pauseGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { parseGoalCommand, type ParsedGoalCommand } from "./command.js"
import { showGoalToast } from "./toast.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type GoalAction = ParsedGoalCommand["action"]

export const DEFAULT_RESTRICTED_GOAL_AGENTS = ["plan"] as const

export function isRestrictedGoalAgent(agent: unknown): agent is string {
  if (typeof agent !== "string") return false
  const normalized = agent.trim().toLowerCase()
  return DEFAULT_RESTRICTED_GOAL_AGENTS.includes(normalized as (typeof DEFAULT_RESTRICTED_GOAL_AGENTS)[number])
}

export function restrictedAgentStopReason(agent: string): string {
  return `Paused in restricted agent "${agent}". Switch to Build and run /goal resume to execute.`
}

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function textFromParts(parts: any[]): string {
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

function replaceParts(parts: any[], text: string) {
  // OpenCode 1.18+ persists chat.message parts as durable events. Replacing the
  // host-owned part object with a freshly fabricated `{ type, text }` object
  // drops its id/sessionID/messageID and makes the host reject the prompt before
  // it can be saved. Reuse one existing durable text part and only replace its
  // payload; discard sibling display parts without inventing new identities.
  const durableText = parts.find((part) => part?.type === "text" && typeof part.text === "string")
  if (!durableText) return false
  durableText.text = text
  parts.splice(0, parts.length, durableText)
  return true
}

function withExecutionAgent(goal: GoalState, agent: string): GoalState {
  return {
    ...goal,
    execution: {
      ...(goal.execution ?? {}),
      agent,
    },
    updatedAt: Date.now(),
  }
}

function executionPromptAction(action: GoalAction | undefined): boolean {
  return action === "create" || action === "edit" || action === "resume" || action === "budget"
}

function planBoundaryMessage(goal: GoalState, agent: string): string {
  return `Goal saved but paused in ${agent} mode.\nObjective: ${goal.objective}\nStatus: paused\n\nPlanning-only boundary: continue analysis/planning only. Do not implement, edit files, or autonomously continue this Goal. Ask the user to switch to Build and run /goal resume when implementation should begin.`
}

async function notifyFinalAction(client: any, action: GoalAction | undefined, goal: GoalState | null, boundaryApplied: boolean) {
  if (boundaryApplied && goal) {
    await showGoalToast(client, `Goal paused in ${goal.execution?.agent ?? "restricted"} mode. Switch to Build and resume to execute.`, "warning")
    return
  }
  if (!action || !["create", "edit", "pause", "resume", "clear"].includes(action)) return
  if (action === "clear") {
    await showGoalToast(client, "Goal cleared.", "info")
    return
  }
  if (!goal) return
  if (action === "create") await showGoalToast(client, `Goal active: ${goal.objective}`, "success")
  else if (action === "edit") await showGoalToast(client, `Goal contract updated (revision ${goal.revision}).`, "info")
  else if (action === "pause") await showGoalToast(client, "Goal paused.", "warning")
  else if (action === "resume") await showGoalToast(client, goal.status === "active" ? "Goal resumed." : `Goal remains ${goal.status}.`, goal.status === "active" ? "success" : "warning")
}

/**
 * Treat planning-only agents as an execution boundary, not a prompt preference.
 * A Goal may be defined while Plan is selected, but it cannot become or remain
 * autonomously active until the user switches to a non-restricted agent and
 * explicitly resumes it.
 */
export function installRestrictedAgentSafety(input: PluginInput, hooks: PluginHooks): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  const eventHook = hooks.event
  if (typeof commandHook !== "function" || typeof chatHook !== "function" || typeof eventHook !== "function") return

  const store = new GoalStore(input.directory)
  const pendingActions = new Map<string, GoalAction>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    const parsed = parseGoalCommand(event.arguments ?? "")
    pendingActions.set(event.sessionID, parsed.action)
    try {
      await commandHook(event, output)
    } catch (error) {
      pendingActions.delete(event.sessionID)
      throw error
    }
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const action = pendingActions.get(event.sessionID)
    pendingActions.delete(event.sessionID)

    await chatHook(event, output)

    // Doctor is intentionally available when the normal GoalState parser is not.
    // Do not re-enter store.load() after its read-only diagnostic response.
    if (action === "doctor") return

    const agent = typeof event.agent === "string" ? event.agent.trim() : ""
    let goal = await store.load(event.sessionID)
    let boundaryApplied = false

    if (goal && goal.status !== "completed" && isRestrictedGoalAgent(agent)) {
      const shouldPause = goal.status === "active"
      const shouldBindAgent = goal.execution?.agent?.trim().toLowerCase() !== agent.toLowerCase()
      const genericUserPause = goal.status === "paused" && goal.stopReason === "Paused because the user sent a new message."

      if (shouldPause || shouldBindAgent || genericUserPause) {
        const bound = withExecutionAgent(goal, agent)
        goal = shouldPause || genericUserPause
          ? pauseGoal(bound, restrictedAgentStopReason(agent))
          : bound
        await store.save(goal)
        boundaryApplied = shouldPause || genericUserPause
      }

      if (boundaryApplied) {
        if (executionPromptAction(action)) {
          replaceParts(output.parts, planBoundaryMessage(goal, agent))
        } else if (action) {
          const shown = textFromParts(output.parts)
          replaceParts(output.parts, `${shown}\n\nPlan safety: the Goal is now paused. Switch to Build and run /goal resume before implementation.`)
        }
      }
    }

    await notifyFinalAction(input.client, action, goal, boundaryApplied)
  }

  hooks.event = async (eventInput: any) => {
    const type = String(eventInput?.event?.type ?? "")
    const sessionID = eventSessionID(eventInput)
    if (type === "session.idle" && sessionID) {
      const goal = await store.load(sessionID)
      const agent = goal?.execution?.agent
      if (goal?.status === "active" && isRestrictedGoalAgent(agent)) {
        const paused = pauseGoal(goal, restrictedAgentStopReason(agent))
        await store.save(paused)
        await showGoalToast(input.client, `Goal paused in ${agent} mode. Auto-continue was suppressed.`, "warning")
        return
      }
    }
    await eventHook(eventInput)
  }
}