import { pauseGoal, waitForUserGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { reportBlocker } from "../runtime/blocker.js"
import { runConfiguredChecks } from "../runtime/checks.js"
import { addProgressNote } from "../runtime/progress.js"
import { completeGoal } from "../verification/audit.js"
import { verifyDeclaredFiles } from "../verification/contracts.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "../verification/evidence.js"
import {
  completionNotificationReason,
  createGoalTransitionNotifier,
  notifyGoal,
} from "../opencode/notify.js"
import { SemanticVerifierUnavailableError } from "../opencode/verifier.js"
import type { OpenCode2AutonomousRuntime, OpenCode2GoalExecutionOwner } from "./autonomous-runtime.js"

export const OPENCODE2_GOAL_WORK_TOOLS = [
  "opencode_goal_progress",
  "opencode_goal_evidence_file",
  "opencode_goal_complete",
  "opencode_goal_wait_for_user",
  "opencode_goal_blocked",
] as const

type WorkToolName = typeof OPENCODE2_GOAL_WORK_TOOLS[number]

interface SemanticVerifierLike {
  verify(
    parentSessionID: string,
    goal: GoalState,
    options?: { currentMessageID?: string },
  ): Promise<GoalState>
}

type ToolContext = {
  id?: string
  sessionID?: string
  messageID?: string
  callID?: string
  agent?: string
  progress?: (input: { status: string }) => void | Promise<void>
}

async function nativeProgress(context: ToolContext, status: string): Promise<void> {
  if (typeof context?.progress !== "function") return
  try {
    await context.progress({ status })
  } catch {
    // OpenCode 2 progress rendering is advisory. A TUI/UI progress failure
    // must never change Goal persistence or verification semantics.
  }
}

function response(message: string, goal: GoalState | null = null) {
  return {
    output: {
      message,
      status: goal?.status ?? null,
      goalID: goal?.id ?? null,
      revision: goal?.revision ?? null,
    },
    content: message,
  }
}

const outputSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    status: { anyOf: [{ type: "string" }, { type: "null" }] },
    goalID: { anyOf: [{ type: "string" }, { type: "null" }] },
    revision: { anyOf: [{ type: "integer" }, { type: "null" }] },
  },
  required: ["message", "status", "goalID", "revision"],
  additionalProperties: false,
} as const

function mergeAuditEvaluation(latest: GoalState, evaluated: GoalState): GoalState {
  const latestEvidenceIDs = new Set(latest.evidence.map((item) => item.id))
  return {
    ...latest,
    requirements: evaluated.requirements,
    evidence: [...latest.evidence, ...evaluated.evidence.filter((item) => !latestEvidenceIDs.has(item.id))].slice(-500),
    progressRevision: Math.max(latest.progressRevision, evaluated.progressRevision),
    updatedAt: Date.now(),
  }
}

function settleCurrentProgress(goal: GoalState): GoalState {
  return {
    ...goal,
    observedProgressRevision: goal.progressRevision,
    stalledTurns: 0,
    updatedAt: Date.now(),
  }
}

function sessionID(context: ToolContext): string {
  const value = typeof context?.sessionID === "string" ? context.sessionID.trim() : ""
  if (!value) throw new Error("OpenCode Goal V2 work tool requires a sessionID")
  return value
}

export function createOpenCode2GoalWorkTools(input: {
  autonomousRuntime: OpenCode2AutonomousRuntime
  resolveDirectory(sessionID: string): Promise<string>
  semanticVerifier: SemanticVerifierLike
}) {
  const steeringEpochs = new Map<string, number>()
  const lastForegroundMessage = new Map<string, string>()
  const locks = new Map<string, Promise<unknown>>()

  function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    locks.set(id, next)
    return next.finally(() => {
      if (locks.get(id) === next) locks.delete(id)
    })
  }

  function currentSteeringEpoch(id: string): number {
    return steeringEpochs.get(id) ?? 0
  }

  function markForegroundSteering(id: string, messageID: string): void {
    if (!messageID || lastForegroundMessage.get(id) === messageID) return
    lastForegroundMessage.set(id, messageID)
    steeringEpochs.set(id, currentSteeringEpoch(id) + 1)
  }

  function clearSession(id: string): void {
    steeringEpochs.delete(id)
    lastForegroundMessage.delete(id)
    locks.delete(id)
  }

  function ownerFor(id: string, goal: GoalState): OpenCode2GoalExecutionOwner | undefined {
    const owner = input.autonomousRuntime.executionOwnerBySession.get(id)
    if (!owner || owner.goalID !== goal.id || owner.revision !== goal.revision) return undefined
    return owner
  }

  async function currentOwnedGoal(context: ToolContext): Promise<{
    id: string
    directory: string
    store: GoalStore
    goal: GoalState
    owner: OpenCode2GoalExecutionOwner
  } | { rejection: string }> {
    const id = sessionID(context)
    const directory = await input.resolveDirectory(id)
    const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })
    const goal = await store.load(id)
    if (!goal) return { rejection: "No active goal." }
    if (goal.status !== "active") return { rejection: `Rejected: goal status is ${goal.status}.` }
    const owner = ownerFor(id, goal)
    if (!owner) return { rejection: "Rejected: this tool call is not owned by the current Goal execution." }
    return { id, directory, store, goal, owner }
  }

  function hideFrom(event: any): void {
    if (!event?.tools || typeof event.tools !== "object") return
    for (const name of OPENCODE2_GOAL_WORK_TOOLS) delete event.tools[name]
  }

  function handleContext(event: any): boolean {
    const id = typeof event?.sessionID === "string"
      ? event.sessionID
      : typeof event?.data?.sessionID === "string"
        ? event.data.sessionID
        : undefined
    if (!id) {
      hideFrom(event)
      return false
    }
    const messages = Array.isArray(event?.messages) ? event.messages : []
    let lastUserMessageID: string | undefined
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (String(message?.role ?? "").toLowerCase() !== "user") continue
      lastUserMessageID = typeof message?.id === "string"
        ? message.id
        : typeof message?.info?.id === "string" ? message.info.id : undefined
      break
    }
    if (!lastUserMessageID && typeof event?.messageID === "string") lastUserMessageID = event.messageID

    const owner = input.autonomousRuntime.executionOwnerBySession.get(id)
    const owned = Boolean(owner && lastUserMessageID && owner.messageID === lastUserMessageID)
    if (!owned) hideFrom(event)
    return owned
  }

  const definitions: Record<WorkToolName, any> = {
    opencode_goal_progress: {
      description: "Record a checkpoint note. This does not count as verified progress by itself.",
      input: {
        type: "object",
        properties: {
          summary: { type: "string" },
          next: { type: "string" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      output: outputSchema,
      execute: async (args: any, context: ToolContext) => {
        const id = sessionID(context)
        return await serialize(id, async () => {
          const current = await currentOwnedGoal(context)
          if ("rejection" in current) return response(current.rejection)
          const next = addProgressNote(current.goal, {
            summary: String(args?.summary ?? ""),
            ...(typeof args?.next === "string" && args.next.trim() ? { next: args.next.trim() } : {}),
          })
          await current.store.save(next)
          return response("Checkpoint recorded. Note: checkpoint text is not completion evidence.", next)
        })
      },
    },

    opencode_goal_evidence_file: {
      description: "Ask the host to verify a predeclared project-file requirement. Semantic/objective requirements are verified by completion audit instead.",
      input: {
        type: "object",
        properties: { requirementID: { type: "string" } },
        required: ["requirementID"],
        additionalProperties: false,
      },
      output: outputSchema,
      execute: async (args: any, context: ToolContext) => {
        const id = sessionID(context)
        return await serialize(id, async () => {
          const current = await currentOwnedGoal(context)
          if ("rejection" in current) return response(current.rejection)
          await nativeProgress(context, "Verifying declared file evidence")
          const checked = await recordFileEvidence(current.goal, {
            root: current.directory,
            requirementID: String(args?.requirementID ?? ""),
          })
          let goal = checked.goal
          if (checked.evidence.passed) goal = proveRequirementsFromEvidence(goal, checked.evidence.id)
          await current.store.save(goal)
          return response(checked.evidence.summary, goal)
        })
      },
    },

    opencode_goal_complete: {
      description: "Attempt verified completion. Host contracts run independently and semantic requirements are audited by a read-only verifier. Completion fails closed.",
      input: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
      output: outputSchema,
      execute: async (args: any, context: ToolContext) => {
        const id = sessionID(context)
        const startingEpoch = currentSteeringEpoch(id)

        const snapshotResult = await serialize(id, async () => await currentOwnedGoal(context))
        if ("rejection" in snapshotResult) return response(snapshotResult.rejection)
        const snapshot = snapshotResult.goal
        const owner = snapshotResult.owner
        const directory = snapshotResult.directory

        await nativeProgress(context, "Running Goal host checks")
        let evaluated = await runConfiguredChecks(snapshot, directory)
        await nativeProgress(context, "Verifying declared file contracts")
        evaluated = await verifyDeclaredFiles(evaluated, directory)
        if (currentSteeringEpoch(id) !== startingEpoch) {
          return response("Completion rejected: user steering arrived while host verification was running. Goal remains active.", snapshot)
        }

        try {
          await nativeProgress(context, "Running independent semantic verification")
          evaluated = await input.semanticVerifier.verify(id, evaluated, { currentMessageID: owner.messageID })
        } catch (error) {
          if (currentSteeringEpoch(id) !== startingEpoch) {
            return response("Completion not verified: user steering arrived while semantic verification was running. Goal remains active.", snapshot)
          }
          if (error instanceof SemanticVerifierUnavailableError) {
            return await serialize(id, async () => {
              if (currentSteeringEpoch(id) !== startingEpoch) {
                return response("Completion not verified: user steering arrived while semantic verification was running. Goal remains active.")
              }
              const current = await currentOwnedGoal(context)
              if ("rejection" in current) {
                return response("Completion not verified: goal changed, paused, or stopped while semantic verification was unavailable.")
              }
              if (current.goal.id !== snapshot.id || current.goal.revision !== snapshot.revision) {
                return response("Completion not verified: goal changed, paused, or stopped while semantic verification was unavailable.", current.goal)
              }
              const merged = settleCurrentProgress(mergeAuditEvaluation(current.goal, evaluated))
              const reason = `Independent semantic verification unavailable: ${error.message}`
              const paused = pauseGoal(merged, reason)
              await current.store.save(paused)
              return response(
                `Completion not verified: ${error.message}. Goal paused to prevent repeated verifier retries. Use /goal resume to retry after the verifier/provider recovers.`,
                paused,
              )
            })
          }
          return response(`Completion rejected: independent semantic verification failed closed (${String(error)}).`, snapshot)
        }

        return await serialize(id, async () => {
          if (currentSteeringEpoch(id) !== startingEpoch) {
            return response("Completion rejected: user steering arrived while verification was running. Goal remains active.")
          }
          const current = await currentOwnedGoal(context)
          if ("rejection" in current) {
            return response("Completion rejected: goal changed, paused, or stopped while verification was running.")
          }
          if (current.goal.id !== snapshot.id || current.goal.revision !== snapshot.revision) {
            return response("Completion rejected: goal changed, paused, or stopped while verification was running.", current.goal)
          }
          await nativeProgress(context, "Finalizing verified Goal completion")
          const merged = settleCurrentProgress(mergeAuditEvaluation(current.goal, evaluated))
          const result = completeGoal(merged, String(args?.summary ?? ""))
          await current.store.save(result.goal)
          const rejection = completionNotificationReason(result.goal, result.audit)
          if (rejection) notifyGoal(current.directory, result.goal, rejection)
          return response(
            result.audit.ok
              ? "Goal completed with host and verifier-backed evidence."
              : `Completion rejected:\n- ${result.audit.reasons.join("\n- ")}`,
            result.goal,
          )
        })
      },
    },

    opencode_goal_wait_for_user: {
      description: "Put the active Goal to sleep when required progress genuinely depends on new user input, approval, credentials, production/manual action, or external data the agent cannot obtain.",
      input: {
        type: "object",
        properties: {
          reason: { type: "string" },
          needed: { type: "string" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
      output: outputSchema,
      execute: async (args: any, context: ToolContext) => {
        const id = sessionID(context)
        return await serialize(id, async () => {
          const current = await currentOwnedGoal(context)
          if ("rejection" in current) return response(current.rejection)
          const next = waitForUserGoal(current.goal, {
            reason: String(args?.reason ?? ""),
            ...(typeof args?.needed === "string" && args.needed.trim() ? { needed: args.needed.trim() } : {}),
          })
          await current.store.save(next)
          return response(
            "Goal is waiting for user input. End this assistant turn without more project work or polling; autonomous Goal continuation is asleep until the user resumes it.",
            next,
          )
        })
      },
    },

    opencode_goal_blocked: {
      description: "Report a genuine blocker. The same blocker must recur on three distinct Goal turns before the Goal becomes blocked.",
      input: {
        type: "object",
        properties: {
          reason: { type: "string" },
          needed: { type: "string" },
          key: { type: "string" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
      output: outputSchema,
      execute: async (args: any, context: ToolContext) => {
        const id = sessionID(context)
        return await serialize(id, async () => {
          const current = await currentOwnedGoal(context)
          if ("rejection" in current) return response(current.rejection)
          const next = reportBlocker(current.goal, {
            turnID: current.owner.messageID,
            reason: String(args?.reason ?? ""),
            ...(typeof args?.needed === "string" && args.needed.trim() ? { needed: args.needed.trim() } : {}),
            ...(typeof args?.key === "string" && args.key.trim() ? { key: args.key.trim() } : {}),
          })
          await current.store.save(next)
          const count = next.blockerAudit?.consecutiveTurns ?? 0
          return response(
            next.status === "blocked"
              ? `Goal blocked after ${count} repeated blocker turns.`
              : `Blocker recorded (${count}/3). Keep working on other useful paths if possible.`,
            next,
          )
        })
      },
    },
  }

  return {
    definitions,
    hideFrom,
    handleContext,
    markForegroundSteering,
    clearSession,
    currentSteeringEpoch,
    toolNames: OPENCODE2_GOAL_WORK_TOOLS,
  }
}
