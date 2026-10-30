import { pauseGoal, waitForUserGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore, mutateGoal } from "../persistence/store.js"
import { reportBlocker } from "../runtime/blocker.js"
import { runConfiguredChecks } from "../runtime/checks.js"
import { addProgressNote } from "../runtime/progress.js"
import { completeGoal, completionSnapshotIdentity } from "../verification/audit.js"
import { fileRequirementOutcomes, verifyDeclaredFiles } from "../verification/contracts.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "../verification/evidence.js"
import {
  completionNotificationReason,
  createGoalTransitionNotifier,
  notifyGoal,
} from "../opencode/notify.js"
import { SemanticVerifierUnavailableError } from "../verification/verifier-evidence.js"
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

const MAX_COMPLETION_VERIFICATION_ATTEMPTS = 3

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

  function markForegroundAdmission(id: string): void {
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
          const result = await mutateGoal(current.store, id, (latest) => {
            if (latest.status !== "active" || !ownerFor(id, latest)) return null
            return addProgressNote(latest, {
              summary: String(args?.summary ?? ""),
              ...(typeof args?.next === "string" && args.next.trim() ? { next: args.next.trim() } : {}),
            })
          })
          if (!result?.wrote) return response("Rejected: the Goal changed before the checkpoint was recorded.")
          return response("Checkpoint recorded. Note: checkpoint text is not completion evidence.", result.goal)
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
          let summary: string | undefined
          const result = await mutateGoal(current.store, id, async (latest) => {
            if (latest.status !== "active" || !ownerFor(id, latest)) return null
            const checked = await recordFileEvidence(latest, {
              root: current.directory,
              requirementID: String(args?.requirementID ?? ""),
            })
            summary = checked.evidence.summary
            return checked.evidence.passed ? proveRequirementsFromEvidence(checked.goal, checked.evidence.id) : checked.goal
          })
          if (!result?.wrote || summary === undefined) return response("Rejected: the Goal changed before file evidence could be recorded.")
          return response(summary, result.goal)
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

        const initialResult = await serialize(id, async () => await currentOwnedGoal(context))
        if ("rejection" in initialResult) return response(initialResult.rejection)
        const initial = initialResult.goal
        const owner = initialResult.owner
        const directory = initialResult.directory
        if ((initial.completionMode ?? "verified") === "continuous") {
          return response("Completion disabled: this Goal is continuous. Keep working until the user pauses/clears it or a safety boundary stops it; use /goalx edit <objective> --verified to re-enable verified completion.", initial)
        }

        for (let attempt = 0; attempt < MAX_COMPLETION_VERIFICATION_ATTEMPTS; attempt += 1) {
          const snapshotResult = attempt === 0
            ? initialResult
            : await serialize(id, async () => await currentOwnedGoal(context))
          if ("rejection" in snapshotResult) {
            return response("Completion rejected: goal changed, paused, or stopped while verification was running.")
          }
          const snapshot = snapshotResult.goal
          if (snapshot.id !== initial.id || snapshot.revision !== initial.revision || snapshot.status !== "active") {
            return response("Completion rejected: goal changed, paused, or stopped while verification was running.", snapshot)
          }
          const verifiedIdentity = completionSnapshotIdentity(snapshot)

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
                const reason = `Independent semantic verification unavailable: ${error.message}`
                const result = await mutateGoal(current.store, id, (latest) => {
                  if (latest.status !== "active" || !ownerFor(id, latest)) return null
                  if (latest.id !== snapshot.id || latest.revision !== snapshot.revision) return null
                  const merged = completionSnapshotIdentity(latest) === verifiedIdentity
                    ? settleCurrentProgress(mergeAuditEvaluation(latest, evaluated))
                    : latest
                  return pauseGoal(merged, reason)
                })
                if (!result?.wrote) {
                  return response("Completion not verified: goal changed, paused, or stopped while semantic verification was unavailable.", result?.goal ?? null)
                }
                return response(
                  `Completion not verified: ${error.message}. Goal paused to prevent repeated verifier retries. Use /goalx resume to retry after the verifier/provider recovers.`,
                  result.goal,
                )
              })
            }
            return response(`Completion rejected: independent semantic verification failed closed (${String(error)}).`, snapshot)
          }

          const verified = evaluated
          const finalize: { response?: ReturnType<typeof response>; changed?: boolean } = await serialize(id, async () => {
            if (currentSteeringEpoch(id) !== startingEpoch) {
              return { response: response("Completion rejected: user steering arrived while verification was running. Goal remains active.") }
            }
            await nativeProgress(context, "Finalizing verified Goal completion")
            let completed: ReturnType<typeof completeGoal> | undefined
            let changed = false
            const result = await mutateGoal(snapshotResult.store, id, async (latest) => {
              if (latest.status !== "active" || !ownerFor(id, latest)) return null
              if (
                latest.id !== snapshot.id
                || latest.revision !== snapshot.revision
                || completionSnapshotIdentity(latest) !== verifiedIdentity
              ) {
                changed = true
                return null
              }
              const refreshedFiles = await verifyDeclaredFiles(latest, directory)
              if (fileRequirementOutcomes(refreshedFiles) !== fileRequirementOutcomes(verified)) {
                changed = true
                return null
              }
              const merged = settleCurrentProgress(mergeAuditEvaluation(latest, verified))
              completed = completeGoal(merged, String(args?.summary ?? ""))
              return completed.goal
            })
            const audit = completed?.audit
            if (!result?.wrote || !audit) {
              if (changed) return { changed: true }
              return { response: response("Completion rejected: goal changed, paused, or stopped while verification was running.", result?.goal ?? null) }
            }
            const rejection = completionNotificationReason(result.goal, audit)
            if (rejection) notifyGoal(directory, result.goal, rejection)
            return {
              response: response(
                audit.ok
                  ? "Goal completed with host and verifier-backed evidence."
                  : `Completion rejected:\n- ${audit.reasons.join("\n- ")}`,
                result.goal,
              ),
            }
          })
          if (finalize.response) return finalize.response
          if (!finalize.changed) {
            return response("Completion rejected: goal changed, paused, or stopped while verification was running.", null)
          }
        }

        return response("Completion rejected: goal changed while verification was running. Re-run completion against the fresh Goal state.", null)
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
          const result = await mutateGoal(current.store, id, (latest) => {
            if (latest.status !== "active" || !ownerFor(id, latest)) return null
            return waitForUserGoal(latest, {
              reason: String(args?.reason ?? ""),
              ...(typeof args?.needed === "string" && args.needed.trim() ? { needed: args.needed.trim() } : {}),
            })
          })
          if (!result?.wrote) return response("Waiting-user rejected: the Goal changed before it could be persisted.")
          return response(
            "Goal is waiting for user input. End this assistant turn without more project work or polling; autonomous Goal continuation is asleep until the user resumes it.",
            result.goal,
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
          const result = await mutateGoal(current.store, id, (latest) => {
            if (latest.status !== "active" || !ownerFor(id, latest)) return null
            return reportBlocker(latest, {
              turnID: current.owner.messageID,
              reason: String(args?.reason ?? ""),
              ...(typeof args?.needed === "string" && args.needed.trim() ? { needed: args.needed.trim() } : {}),
              ...(typeof args?.key === "string" && args.key.trim() ? { key: args.key.trim() } : {}),
            })
          })
          if (!result?.wrote) return response("Rejected: the Goal changed before the blocker was recorded.")
          const count = result.goal.blockerAudit?.consecutiveTurns ?? 0
          return response(
            result.goal.status === "blocked"
              ? `Goal blocked after ${count} repeated blocker turns.`
              : `Blocker recorded (${count}/3). Keep working on other useful paths if possible.`,
            result.goal,
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
    markForegroundAdmission,
    clearSession,
    currentSteeringEpoch,
    toolNames: OPENCODE2_GOAL_WORK_TOOLS,
  }
}
