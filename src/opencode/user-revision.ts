import { tool } from "@opencode-ai/plugin/tool"
import type CorePlugin from "./plugin.js"
import { editGoal } from "../domain/goal.js"
import type { GoalExecutionContext, GoalState, GoalStatus } from "../domain/types.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import { continuationPrompt } from "./prompt.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

export type GoalUserRevisionMode = "extend" | "replace"

interface UserRevisionAuthorization {
  sessionID: string
  goalID: string
  goalRevision: number
  userMessageID: string
  assistantMessageID?: string
  text: string
  execution?: GoalExecutionContext
  expiresAt: number
}

const AUTHORIZATION_TTL_MS = 10 * 60_000
const COMMAND_OUTPUT_TTL_MS = 60_000
const REVISION_BOUNDARY_TTL_MS = 60_000
const REVISION_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch", "bash", "todowrite", "task"])
const CONTINUATION_PREFIX = "Continue working toward the active OpenCode goal.\n\n<objective>\n"

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function userMessageID(event: any, output: any): string | undefined {
  if (typeof event?.messageID === "string" && event.messageID) return event.messageID
  if (typeof output?.message?.id === "string" && output.message.id) return output.message.id
  return undefined
}

function executionContext(event: any, goal: GoalState): GoalExecutionContext | undefined {
  const context: GoalExecutionContext = {
    ...(event?.agent ? { agent: event.agent } : {}),
    ...(event?.model ? { model: event.model } : {}),
    ...(event?.variant ? { variant: event.variant } : {}),
    ...(goal.execution?.modelContext ? { modelContext: goal.execution.modelContext } : {}),
  }
  return Object.keys(context).length ? context : goal.execution
}

function eligibleRevisionStatus(status: GoalStatus): boolean {
  return status === "active" || status === "paused" || status === "blocked"
}

function goalOwnedContinuation(goal: GoalState, text: string): boolean {
  if (!text.startsWith(CONTINUATION_PREFIX)) return false
  return text === continuationPrompt(goal)
}

function isSyntheticHostMessage(output: any): boolean {
  if (output?.noReply === true) return true
  return Array.isArray(output?.parts) && output.parts.some((part: any) => part?.synthetic === true)
}

function revisionAdvisory(goal: GoalState): string {
  return [
    "<opencode_goal_user_revision>",
    `A persisted OpenCode Goal exists (status=${goal.status}, revision=${goal.revision}).`,
    "This is a foreground human message. It does not silently rewrite the Goal contract.",
    "If this message materially ADDS required work to the existing Goal, call opencode_goal_revise_from_user with mode=extend before implementing the changed scope.",
    "If this message intentionally REPLACES the requested outcome, call opencode_goal_revise_from_user with mode=replace before implementing the changed scope.",
    "Do not revise for questions, status/explanation requests, or ordinary steering that already fits the current Goal. Short explicit resume messages are handled separately.",
    "The revision tool can consume only this exact latest human message; it accepts no model-authored objective text. A successful revision creates a turn boundary, so end the current assistant turn and let the next Goal-owned turn re-plan and continue.",
    "</opencode_goal_user_revision>",
  ].join("\n")
}

function appendRevisionAdvisory(output: any, goal: GoalState): void {
  if (!Array.isArray(output?.parts)) return
  // OpenCode persists chat.message parts as durable events. A newly pushed text
  // part would need host-issued id/sessionID/messageID fields, and fabricating or
  // cloning those identities is unsafe. Extend an existing host-owned text part
  // in place instead. Authorization has already captured the raw human text, so
  // the persisted Goal revision can still use that exact unmodified instruction.
  for (let index = output.parts.length - 1; index >= 0; index -= 1) {
    const part = output.parts[index]
    if (part?.type !== "text" || typeof part.text !== "string") continue
    part.text = `${part.text}\n\n${revisionAdvisory(goal)}`
    return
  }
}

export function reviseGoalFromForegroundUser(goal: GoalState, input: {
  text: string
  mode: GoalUserRevisionMode
  execution?: GoalExecutionContext
  now?: number
}): GoalState {
  if (!eligibleRevisionStatus(goal.status)) {
    throw new Error(`Goal status ${goal.status} cannot be revised implicitly; use explicit Goal lifecycle/budget controls.`)
  }
  const text = input.text.trim()
  if (!text) throw new Error("foreground user instruction must not be empty")
  const objective = input.mode === "replace"
    ? text
    : `${goal.objective.trim()}\n\nAdditional user instruction:\n${text}`
  const next = editGoal(goal, {
    objective,
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  // A material scope revision must force a fresh execution plan. Keeping the
  // previous Todo snapshot as stale telemetry is safe for completion, but it is
  // counterproductive for a user-driven re-plan because models can keep visually
  // anchoring on the old checklist. Historical work/evidence remains in Goal state.
  delete next.todoPlan
  // The first revised Goal turn may legitimately spend its work on fresh
  // reconnaissance/re-planning before mutating the workspace. Give that one
  // turn the existing one-shot stall exemption instead of treating a correct
  // revision boundary as the first strike toward an automatic pause.
  next.skipNextStallCheck = true
  return next
}

class UserRevisionAuthorizations {
  #bySession = new Map<string, UserRevisionAuthorization>()

  clear(sessionID: string): void {
    this.#bySession.delete(sessionID)
  }

  capture(goal: GoalState, input: {
    userMessageID: string
    text: string
    execution?: GoalExecutionContext
    now?: number
  }): void {
    const now = input.now ?? Date.now()
    this.#bySession.set(goal.sessionID, {
      sessionID: goal.sessionID,
      goalID: goal.id,
      goalRevision: goal.revision,
      userMessageID: input.userMessageID,
      text: input.text,
      ...(input.execution ? { execution: input.execution } : {}),
      expiresAt: now + AUTHORIZATION_TTL_MS,
    })
  }

  bindAssistant(sessionID: string, parentID: string | undefined, assistantMessageID: string | undefined, now = Date.now()): void {
    const current = this.#bySession.get(sessionID)
    if (!current || current.expiresAt <= now) {
      if (current) this.#bySession.delete(sessionID)
      return
    }
    if (!parentID || !assistantMessageID || current.userMessageID !== parentID) return
    current.assistantMessageID = assistantMessageID
  }

  match(sessionID: string, assistantMessageID: string | undefined, goal: GoalState, now = Date.now()): UserRevisionAuthorization | null {
    const current = this.#bySession.get(sessionID)
    if (!current) return null
    if (current.expiresAt <= now) {
      this.#bySession.delete(sessionID)
      return null
    }
    if (current.goalID !== goal.id || current.goalRevision !== goal.revision) {
      this.#bySession.delete(sessionID)
      return null
    }
    if (!assistantMessageID || current.assistantMessageID !== assistantMessageID) return null
    return current
  }

  consume(sessionID: string, authorization: UserRevisionAuthorization): void {
    if (this.#bySession.get(sessionID) === authorization) this.#bySession.delete(sessionID)
  }
}

/**
 * Give a foreground human follow-up an explicit, one-shot path into the durable
 * Goal contract. The model chooses extend vs replace semantically, but it cannot
 * author arbitrary scope: the host persists the exact latest human message that
 * directly parented the current assistant turn.
 */
export function installGoalUserRevision(input: PluginInput, hooks: PluginHooks): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  const eventHook = hooks.event
  if (typeof commandHook !== "function" || typeof chatHook !== "function" || typeof eventHook !== "function") return

  const store = new GoalStore(input.directory)
  const authorizations = new UserRevisionAuthorizations()
  const commandOutputs = new Map<string, { text: string; expiresAt: number }>()
  const revisionBoundaries = new Map<string, { revision: number; expiresAt: number }>()

  function clearExpiredCommandOutput(sessionID: string, now = Date.now()): string | undefined {
    const current = commandOutputs.get(sessionID)
    if (!current) return undefined
    commandOutputs.delete(sessionID)
    return current.expiresAt > now ? current.text : undefined
  }

  function activeBoundary(sessionID: string, now = Date.now()): { revision: number; expiresAt: number } | undefined {
    const boundary = revisionBoundaries.get(sessionID)
    if (!boundary) return undefined
    if (boundary.expiresAt <= now) {
      revisionBoundaries.delete(sessionID)
      return undefined
    }
    return boundary
  }

  hooks["command.execute.before"] = async (event: any, output: any) => {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
    if (sessionID) {
      authorizations.clear(sessionID)
      revisionBoundaries.delete(sessionID)
    }
    await commandHook(event, output)
    if (!sessionID) return
    const text = textFromParts(output?.parts ?? [])
    if (text) commandOutputs.set(sessionID, { text, expiresAt: Date.now() + COMMAND_OUTPUT_TTL_MS })
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
    if (!sessionID) {
      await chatHook(event, output)
      return
    }

    // A new user/prompt turn is the boundary after a successful revision. Any
    // mutation guard from the assistant turn that created the revision is done.
    revisionBoundaries.delete(sessionID)

    const text = textFromParts(output?.parts ?? [])
    const commandOutput = clearExpiredCommandOutput(sessionID)
    if (commandOutput && commandOutput === text) {
      authorizations.clear(sessionID)
      await chatHook(event, output)
      return
    }

    let goal: GoalState | null
    try {
      goal = await store.load(sessionID)
    } catch {
      // This wrapper is authorization UX, not a second persistence authority.
      // Core Goal storage paths still fail closed through their normal hooks.
      await chatHook(event, output)
      return
    }

    const messageID = userMessageID(event, output)
    const synthetic = isSyntheticHostMessage(output)
    const ownedContinuation = Boolean(goal && goalOwnedContinuation(goal, text))
    authorizations.clear(sessionID)

    if (goal && goal.status !== "completed" && messageID && text.trim() && !synthetic && !ownedContinuation) {
      const execution = executionContext(event, goal)
      authorizations.capture(goal, {
        userMessageID: messageID,
        text,
        ...(execution ? { execution } : {}),
      })
      if (eligibleRevisionStatus(goal.status)) appendRevisionAdvisory(output, goal)
    }

    await chatHook(event, output)
  }

  hooks.event = async (inputEvent: any) => {
    const event = inputEvent?.event
    if (event?.type === "message.updated") {
      const info = event?.properties?.info
      if (info?.role === "assistant") {
        const sessionID = typeof info?.sessionID === "string" ? info.sessionID : ""
        const parentID = typeof info?.parentID === "string" ? info.parentID : undefined
        const assistantMessageID = typeof info?.id === "string" ? info.id : undefined
        if (sessionID) authorizations.bindAssistant(sessionID, parentID, assistantMessageID)
      }
    }
    await eventHook(inputEvent)
  }

  const toolExecuteBefore = hooks["tool.execute.before"]
  hooks["tool.execute.before"] = async (event: any) => {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
    const boundary = sessionID ? activeBoundary(sessionID) : undefined
    if (boundary && REVISION_MUTATION_TOOLS.has(String(event?.tool ?? ""))) {
      throw new Error(`Goal revision r${boundary.revision} was just created from the latest user instruction. End this assistant turn now; the next Goal-owned turn will re-plan and continue the revised scope.`)
    }
    if (typeof toolExecuteBefore === "function") await toolExecuteBefore(event)
  }

  const toolMap = hooks.tool as Record<string, any>
  toolMap.opencode_goal_revise_from_user = tool({
    description: "Promote the exact latest foreground human message into a new revision of the current Goal. Use mode=extend when the user materially adds required work while preserving the existing objective; use mode=replace when the user intentionally replaces the requested outcome. Do not call this for questions, status/explanation requests, short resume messages, or ordinary steering already covered by the current Goal. The host accepts no model-authored objective text: only the one-shot human message that directly parented this assistant turn can be consumed. On success, end this assistant turn; the next Goal-owned turn will rebuild its plan and continue the new revision.",
    args: {
      mode: tool.schema.string(),
    },
    execute: async (args: any, context: any) => {
      const sessionID = typeof context?.sessionID === "string" ? context.sessionID : ""
      const assistantMessageID = typeof context?.messageID === "string" ? context.messageID : undefined
      const mode = args?.mode === "extend" || args?.mode === "replace" ? args.mode as GoalUserRevisionMode : null
      if (!sessionID) return "Goal revision rejected: missing session context."
      if (!mode) return "Goal revision rejected: mode must be extend or replace."

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const goal = await store.load(sessionID)
        if (!goal) return "Goal revision rejected: no persisted Goal exists in this session."
        const authorization = authorizations.match(sessionID, assistantMessageID, goal)
        if (!authorization) {
          return "Goal revision rejected: no unconsumed latest foreground human instruction is authorized for this assistant turn."
        }
        if (!eligibleRevisionStatus(goal.status)) {
          authorizations.consume(sessionID, authorization)
          return `Goal revision rejected: status ${goal.status} requires explicit Goal lifecycle/budget control and cannot be implicitly reactivated.`
        }

        const next = reviseGoalFromForegroundUser(goal, {
          text: authorization.text,
          mode,
          ...(authorization.execution ? { execution: authorization.execution } : {}),
        })
        try {
          await store.save(next)
          authorizations.consume(sessionID, authorization)
          revisionBoundaries.set(sessionID, { revision: next.revision, expiresAt: Date.now() + REVISION_BOUNDARY_TTL_MS })
          return `Goal revised from the exact foreground user instruction: r${goal.revision} -> r${next.revision} (${mode}); status is active. Native Todo telemetry was reset so the next Goal-owned turn must build a fresh plan. End this assistant turn now; do not perform more workspace mutations in the stale pre-revision turn.`
        } catch (error) {
          if (error instanceof GoalStoreConcurrencyError && attempt === 0) continue
          throw error
        }
      }

      return "Goal revision rejected after a concurrent Goal state change; inspect the current Goal before retrying."
    },
  })
}
