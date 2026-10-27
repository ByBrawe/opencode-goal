import { tool } from "@opencode-ai/plugin/tool"
import { createGoal, editGoal, pauseGoal, resumeGoal, waitForUserGoal } from "../domain/goal.js"
import type { GoalExecutionContext, GoalState } from "../domain/types.js"
import { GoalStore, GoalStoreConcurrencyError, mutateGoal } from "../persistence/store.js"
import { accountAssistantUsage } from "../runtime/accounting.js"
import { formatGoalRuntimeFingerprint } from "../runtime/fingerprint.js"
import { assistantInfoHasMeaningfulActivity, assistantPartHasMeaningfulActivity, clearEmptyAssistantTurnStreak, recordEmptyAssistantTurn } from "../runtime/empty-turn.js"
import { reportBlocker } from "../runtime/blocker.js"
import { CADENCE_BOUNDARY_MESSAGE, isClearlyReadOnlyShellCommand, requiresDistinctGoalTurnCadence } from "../runtime/cadence.js"
import { runConfiguredChecks } from "../runtime/checks.js"
import { formatModelContext, observeModelContextLimits, observeModelContextUsage } from "../runtime/model-context.js"
import { collectMutationFingerprints } from "../runtime/mutation-progress.js"
import { addProgressNote, closeObservedTurn, markHostProgress } from "../runtime/progress.js"
import { normalizeNativeTodos, observeTodoPlan } from "../runtime/todo-plan.js"
import { completeGoal, completionSnapshotIdentity } from "../verification/audit.js"
import { fileRequirementOutcomes, verifyDeclaredFiles } from "../verification/contracts.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "../verification/evidence.js"
import { parseGoalCommand } from "./command.js"
import { completionNotificationReason, createGoalTransitionNotifier, notifyGoal } from "./notify.js"
import { TurnOwnership, goalTurnOwner, sameGoalTurn } from "./ownership.js"
import { compactionContext, continuationPrompt } from "./prompt.js"
import { createSemanticVerifierRuntime, SemanticVerifierUnavailableError } from "./verifier.js"
import { showGoalToast } from "./toast.js"

const FILE_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"])
const TODO_TOOL = "todowrite"
const SHELL_TOOL = "bash"

export interface OpenCodeGoalPluginOptions {
  /** Dedicated semantic verifier model in provider/model format. */
  verifierModel?: string
  /** Hard semantic verifier deadline in milliseconds. */
  verifierTimeoutMs?: number
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function formatStatus(goal: GoalState | null): string {
  if (!goal) return "No active goal."
  const req = goal.requirements.map((item, i) => `${i + 1}. [${item.status}] ${item.text}`).join("\n")
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nRuntime: ${formatGoalRuntimeFingerprint(goal.runtimeFingerprint)}\nGoal cumulative usage: ${goal.usage.turns} turns, ${goal.usage.tokens} tokens, cost ${goal.usage.cost.toFixed(4)}\nModel context: ${formatModelContext(goal)}\nRequirements:\n${req}`
}

async function sdkPrompt(client: any, sessionID: string, text: string, execution?: GoalExecutionContext) {
  const body = {
    parts: [{ type: "text", text }],
    ...(execution?.agent ? { agent: execution.agent } : {}),
    ...(execution?.model ? { model: execution.model } : {}),
    ...(execution?.variant ? { variant: execution.variant } : {}),
  }
  return await client.session.prompt({ path: { id: sessionID }, body })
}

async function sdkAbort(client: any, sessionID: string): Promise<boolean> {
  if (!client.session.abort) return false
  try {
    await client.session.abort({ path: { id: sessionID } })
    return true
  } catch {
    return false
  }
}

function optionText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function optionNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

export default async function OpenCodeGoalPlugin(input: any, options: OpenCodeGoalPluginOptions = {}) {
  const { client, directory } = input
  const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })
  const semanticVerifier = createSemanticVerifierRuntime(client, directory, {
    model: optionText(options.verifierModel) ?? optionText(process.env.OPENCODE_GOAL_VERIFIER_MODEL),
    timeoutMs: optionNumber(options.verifierTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS),
  })
  const ownership = new TurnOwnership()
  const dispatching = new Map<string, number>()
  const deferredIdle = new Set<string>()
  const steeringIdleSuppressions = new Map<string, number>()
  const queuedSteeringMessages = new Map<string, string>()
  const steeringEpochs = new Map<string, number>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const sessionContexts = new Map<string, GoalExecutionContext>()
  const toolProgressMessages = new Set<string>()
  const toolProgressOrder: string[] = []
  const meaningfulAssistantMessages = new Set<string>()
  const meaningfulAssistantOrder: string[] = []
  const cadenceMutationReservations = new Map<string, string>()
  let hostAutoCompaction = true
  let hostCompactionReserved: number | undefined

  function serialize<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    sessionLocks.set(sessionID, next)
    return next.finally(() => { if (sessionLocks.get(sessionID) === next) sessionLocks.delete(sessionID) })
  }

  async function load(sessionID: string) { return await store.load(sessionID) }
  async function save(goal: GoalState) { await store.save(goal); return goal }

  function resetCadenceTurn(sessionID: string) {
    cadenceMutationReservations.delete(sessionID)
  }

  function currentSteeringEpoch(sessionID: string): number {
    return steeringEpochs.get(sessionID) ?? 0
  }

  function markUserSteering(sessionID: string): void {
    steeringEpochs.set(sessionID, currentSteeringEpoch(sessionID) + 1)
  }

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

  function rememberToolProgress(messageID: string) {
    if (!messageID || toolProgressMessages.has(messageID)) return
    toolProgressMessages.add(messageID)
    toolProgressOrder.push(messageID)
    while (toolProgressOrder.length > 256) {
      const stale = toolProgressOrder.shift()
      if (stale) toolProgressMessages.delete(stale)
    }
  }

  function rememberMeaningfulAssistant(messageID: unknown) {
    if (typeof messageID !== "string" || !messageID || meaningfulAssistantMessages.has(messageID)) return
    meaningfulAssistantMessages.add(messageID)
    meaningfulAssistantOrder.push(messageID)
    while (meaningfulAssistantOrder.length > 256) {
      const stale = meaningfulAssistantOrder.shift()
      if (stale) meaningfulAssistantMessages.delete(stale)
    }
  }

  function consumeMeaningfulAssistant(messageID: unknown): boolean {
    if (typeof messageID !== "string" || !messageID) return false
    const meaningful = meaningfulAssistantMessages.delete(messageID)
    if (meaningful) {
      const index = meaningfulAssistantOrder.indexOf(messageID)
      if (index >= 0) meaningfulAssistantOrder.splice(index, 1)
    }
    return meaningful
  }

  function suppressNextSteeringIdle(sessionID: string) {
    steeringIdleSuppressions.set(sessionID, Date.now() + 5_000)
  }

  function consumeSteeringIdle(sessionID: string): boolean {
    const expiresAt = steeringIdleSuppressions.get(sessionID)
    if (!expiresAt) return false
    steeringIdleSuppressions.delete(sessionID)
    return expiresAt >= Date.now()
  }

  async function abortGoalTurn(sessionID: string, suppressIdle: boolean) {
    resetCadenceTurn(sessionID)
    if (suppressIdle) suppressNextSteeringIdle(sessionID)
    deferredIdle.delete(sessionID)
    const aborted = await sdkAbort(client, sessionID)
    if (aborted) {
      dispatching.delete(sessionID)
      if (suppressIdle) setTimeout(() => steeringIdleSuppressions.delete(sessionID), 5_000)
    } else if (suppressIdle) {
      steeringIdleSuppressions.delete(sessionID)
    }
    return aborted
  }

  function staleToolReason(context: any, goal: GoalState): string | null {
    const messageID = typeof context?.messageID === "string" ? context.messageID : undefined
    const expected = goalTurnOwner(goal)
    const known = ownership.isCurrentAssistant(messageID, expected)
    if (known === false) return "Rejected: this tool call belongs to an older goal revision."
    if (known === undefined && messageID) {
      const active = ownership.activeOwner(context.sessionID)
      if (active && !sameGoalTurn(active, expected)) return "Rejected: this tool call is not owned by the current goal revision."
      if (active && ownership.activeMessageID(context.sessionID) !== messageID) return "Rejected: this tool call is not owned by the active goal turn."
    }
    return null
  }

  async function prepareContinuation(sessionID: string): Promise<{ token: number; goal: GoalState; text: string } | null> {
    return await serialize(sessionID, async () => {
      if (dispatching.has(sessionID)) {
        deferredIdle.add(sessionID)
        return null
      }
      const result = await mutateGoal(store, sessionID, (latest) => latest.status === "active" ? closeObservedTurn(latest) : null)
      const goal = result?.goal
      if (!goal || goal.status !== "active") return null
      resetCadenceTurn(sessionID)
      const token = Date.now() + Math.random()
      const text = continuationPrompt(goal)
      dispatching.set(sessionID, token)
      ownership.rememberPrompt(sessionID, text, goalTurnOwner(goal))
      return { token, goal, text }
    })
  }

  async function continueIfActive(sessionID: string) {
    const prepared = await prepareContinuation(sessionID)
    if (!prepared) return
    void sdkPrompt(client, sessionID, prepared.text, prepared.goal.execution)
      .catch(async (error) => {
        await serialize(sessionID, async () => {
          await mutateGoal(store, sessionID, (latest) => {
            if (latest.status !== "active" || dispatching.get(sessionID) !== prepared.token) return null
            return pauseGoal(latest, `Continuation dispatch failed: ${String(error)}`)
          })
        })
      })
      .finally(() => {
        if (dispatching.get(sessionID) === prepared.token) dispatching.delete(sessionID)
        if (deferredIdle.delete(sessionID)) queueMicrotask(() => { void continueIfActive(sessionID) })
      })
  }

  function markCommandOutputOwned(sessionID: string, output: any, text: string, goal?: GoalState) {
    replaceParts(output.parts, text)
    ownership.rememberPrompt(sessionID, text, goal ? goalTurnOwner(goal) : undefined)
  }

  return {
    config: async (config: any) => {
      hostAutoCompaction = config.compaction?.auto !== false
      hostCompactionReserved = optionNumber(config.compaction?.reserved)
      semanticVerifier.configure(config)
      config.command ||= {}
      config.command.goal ||= {
        description: "Set or manage a persistent evidence-verified goal.",
        template: "$ARGUMENTS",
      }
    },

    "command.execute.before": async (event: any, output: any) => {
      if (event.command !== "goal") return
      let abortControl: string = "none"
      await serialize(event.sessionID, async () => {
        const parsed = parseGoalCommand(event.arguments ?? "")
        let goal = await load(event.sessionID)
        if (parsed.action === "status") {
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, `${formatStatus(goal)}\nRespond with this status only; do not perform work.`)
          return
        }
        if (parsed.action === "pause") {
          resetCadenceTurn(event.sessionID)
          if (goal) goal = await save(pauseGoal(goal))
          if (ownership.activeOwner(event.sessionID) || dispatching.has(event.sessionID)) abortControl = "pause"
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, `${formatStatus(goal)}\nRespond only with OK.`)
          return
        }
        if (parsed.action === "resume") {
          resetCadenceTurn(event.sessionID)
          if (goal) goal = await save(resumeGoal(goal))
          markCommandOutputOwned(event.sessionID, output, goal ? continuationPrompt(goal) : "No goal exists. Respond only with that fact.", goal ?? undefined)
          return
        }
        if (parsed.action === "clear") {
          resetCadenceTurn(event.sessionID)
          if (ownership.activeOwner(event.sessionID) || dispatching.has(event.sessionID)) abortControl = "pause"
          await store.clear(event.sessionID)
          steeringEpochs.delete(event.sessionID)
          queuedSteeringMessages.delete(event.sessionID)
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, "Goal cleared. Respond only with OK.")
          return
        }
        if (!parsed.objective) throw new Error("Usage: /goal <objective> [--accept \"criterion\"] [--check \"command\"]")
        if (parsed.unitCommand || parsed.freshSessionPerUnit) {
          throw new Error("Per-unit fresh-session rotation requires OpenCode 2; the V1 lifecycle does not create a second ownership path.")
        }
        const execution = sessionContexts.get(event.sessionID)
        resetCadenceTurn(event.sessionID)
        if (parsed.action === "edit") {
          if (!goal) throw new Error("No goal exists to edit")
          const previousOwner = goalTurnOwner(goal)
          goal = editGoal(goal, {
            objective: parsed.objective,
            ...(parsed.completionMode ? { completionMode: parsed.completionMode } : {}),
            ...(parsed.acceptance.length ? { acceptance: parsed.acceptance } : {}),
            ...(parsed.checks.length ? { checks: parsed.checks } : {}),
            ...(parsed.files.length ? { files: parsed.files } : {}),
            ...(parsed.notifyCommand ? { notifyCommand: parsed.notifyCommand } : {}),
            ...(execution ? { execution } : {}),
          })
          if (sameGoalTurn(ownership.activeOwner(event.sessionID), previousOwner) || dispatching.has(event.sessionID)) abortControl = "edit"
        } else {
          if (goal && goal.status !== "completed") throw new Error("An unfinished goal already exists. Use /goal edit, /goal clear, or complete it first.")
          goal = createGoal({
            sessionID: event.sessionID,
            objective: parsed.objective,
            ...(parsed.completionMode ? { completionMode: parsed.completionMode } : {}),
            acceptance: parsed.acceptance,
            checks: parsed.checks,
            files: parsed.files,
            ...(parsed.notifyCommand ? { notifyCommand: parsed.notifyCommand } : {}),
            ...(execution ? { execution } : {}),
            budget: {
              ...(parsed.maxTurns ? { maxTurns: parsed.maxTurns } : {}),
              ...(parsed.maxTokens ? { maxTokens: parsed.maxTokens } : {}),
              ...(parsed.maxRuntimeMs ? { maxRuntimeMs: parsed.maxRuntimeMs } : {}),
              ...(parsed.maxCost ? { maxCost: parsed.maxCost } : {}),
            },
          })
        }
        await save(goal)
        markCommandOutputOwned(event.sessionID, output, continuationPrompt(goal), goal)
      })
      if (abortControl === "edit") await abortGoalTurn(event.sessionID, true)
      else if (abortControl === "pause") await abortGoalTurn(event.sessionID, false)
    },

    "chat.message": async (event: any, output: any) => {
      const context: GoalExecutionContext = {
        ...(event.agent ? { agent: event.agent } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.variant ? { variant: event.variant } : {}),
      }
      if (Object.keys(context).length) sessionContexts.set(event.sessionID, context)
      const messageText = textFromParts(output?.parts ?? [])
      const userMessageID = typeof event.messageID === "string"
        ? event.messageID
        : typeof output?.message?.id === "string" ? output.message.id : undefined
      const owned = ownership.consumePrompt(event.sessionID, messageText, userMessageID)
      if (owned) {
        const owner = owned.owner
        if (owner && Object.keys(context).length) {
          await serialize(event.sessionID, async () => {
            await mutateGoal(store, event.sessionID, (latest) => {
              if (latest.status === "completed" || !sameGoalTurn(owner, goalTurnOwner(latest))) return null
              return {
                ...latest,
                execution: {
                  ...context,
                  ...(latest.execution?.modelContext ? { modelContext: latest.execution.modelContext } : {}),
                },
                updatedAt: Date.now(),
              }
            })
          })
        }
        return
      }

      let steeringInFlight = false
      await serialize(event.sessionID, async () => {
        const goal = await load(event.sessionID)
        if (goal?.status !== "active") return
        resetCadenceTurn(event.sessionID)
        markUserSteering(event.sessionID)
        ownership.rememberUserMessage(event.sessionID, userMessageID, goalTurnOwner(goal))
        steeringInFlight = Boolean(ownership.activeOwner(event.sessionID) || dispatching.has(event.sessionID))
        if (steeringInFlight && userMessageID) queuedSteeringMessages.set(event.sessionID, userMessageID)
        if (Object.keys(context).length) {
          await mutateGoal(store, event.sessionID, (latest) => {
            if (latest.status !== "active" || latest.id !== goal.id || latest.revision !== goal.revision) return null
            return {
              ...latest,
              execution: {
                ...context,
                ...(latest.execution?.modelContext ? { modelContext: latest.execution.modelContext } : {}),
              },
              updatedAt: Date.now(),
            }
          })
        }
      })
      if (steeringInFlight) await abortGoalTurn(event.sessionID, true)
    },

    "chat.params": async (event: any) => {
      await serialize(event.sessionID, async () => {
        await mutateGoal(store, event.sessionID, (goal) => {
          if (goal.status === "completed") return null
          const next = observeModelContextLimits(goal, {
            model: event.model,
            autoCompaction: hostAutoCompaction,
            ...(hostCompactionReserved !== undefined ? { compactionReserved: hostCompactionReserved } : {}),
          })
          return next === goal ? null : next
        })
      })
    },

    "tool.execute.before": async (event: any) => {
      rememberMeaningfulAssistant(ownership.activeMessageID(event.sessionID))
      if (event.tool === SHELL_TOOL) {
        if (isClearlyReadOnlyShellCommand(event?.args?.command)) return
        await serialize(event.sessionID, async () => {
          const goal = await load(event.sessionID)
          if (goal?.status === "active" && requiresDistinctGoalTurnCadence(goal) && cadenceMutationReservations.has(event.sessionID)) {
            throw new Error(CADENCE_BOUNDARY_MESSAGE)
          }
        })
        return
      }
      if (event.tool !== TODO_TOOL && !FILE_MUTATION_TOOLS.has(event.tool)) return
      const call = ownership.rememberActiveTool(event.sessionID, event.callID, event.tool !== TODO_TOOL)
      if (!call || event.tool === TODO_TOOL) return
      await serialize(event.sessionID, async () => {
        const goal = await load(event.sessionID)
        if (!goal || goal.status !== "active" || !sameGoalTurn(call.owner, goalTurnOwner(goal)) || !requiresDistinctGoalTurnCadence(goal)) return
        const reserved = cadenceMutationReservations.get(event.sessionID)
        if (reserved && reserved !== event.callID) throw new Error(CADENCE_BOUNDARY_MESSAGE)
        cadenceMutationReservations.set(event.sessionID, event.callID)
      })
    },

    "tool.execute.after": async (event: any, output: any) => {
      if (event.tool !== TODO_TOOL && !FILE_MUTATION_TOOLS.has(event.tool)) return
      const call = ownership.consumeToolCall(event.sessionID, event.callID)
      if (!call) return

      if (event.tool === TODO_TOOL) {
        const todos = normalizeNativeTodos(output?.metadata?.todos ?? event?.args?.todos)
        if (!todos) return
        await serialize(event.sessionID, async () => {
          try {
            await mutateGoal(store, event.sessionID, (goal) => {
              if (goal.status !== "active" || !sameGoalTurn(call.owner, goalTurnOwner(goal))) return null
              const next = observeTodoPlan(goal, todos)
              return next === goal ? null : next
            })
          } catch (error) {
            // Todo telemetry is advisory. Cross-process contention must not turn
            // an otherwise successful native todowrite into a Goal failure.
            if (error instanceof GoalStoreConcurrencyError) return
            throw error
          }
        })
        return
      }

      let madeProgress = false
      try {
        const fingerprints = await collectMutationFingerprints({
          root: directory,
          tool: event.tool,
          args: event.args,
          metadata: output?.metadata,
        })
        if (fingerprints.length === 0) return
        await serialize(event.sessionID, async () => {
          const result = await mutateGoal(store, event.sessionID, (goal) => {
            if (goal.status !== "active" || !sameGoalTurn(call.owner, goalTurnOwner(goal))) return null
            const before = goal.progressRevision
            let next = goal
            for (const item of fingerprints) {
              next = markHostProgress(next, {
                fingerprint: item.fingerprint,
                source: `tool:${event.tool}`,
                summary: item.summary,
              })
            }
            return next.progressRevision === before ? null : next
          })
          if (result?.wrote) {
            madeProgress = true
            rememberToolProgress(call.messageID)
            notifyGoal(directory, result.goal, "progress")
          }
        })
      } finally {
        if (!madeProgress && cadenceMutationReservations.get(event.sessionID) === event.callID) {
          cadenceMutationReservations.delete(event.sessionID)
        }
      }
    },

    "experimental.session.compacting": async (event: any, output: any) => {
      const goal = await load(event.sessionID)
      if (goal) output.context.push(compactionContext(goal))
    },

    "experimental.compaction.autocontinue": async (event: any, output: any) => {
      const goal = await load(event.sessionID)
      if (goal?.status === "active") output.enabled = false
    },

    event: async ({ event }: any) => {
      const type = String(event?.type ?? "")
      const properties = event?.properties ?? {}
      const sessionID = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
      if (!sessionID) return
      if (type === "message.updated") {
        const info = properties.info
        if (info?.role !== "assistant") return
        if (assistantInfoHasMeaningfulActivity(info)) rememberMeaningfulAssistant(info?.id)
        const queuedSteeringMessageID = queuedSteeringMessages.get(sessionID)
        if (queuedSteeringMessageID && info?.parentID === queuedSteeringMessageID) {
          queuedSteeringMessages.delete(sessionID)
          steeringIdleSuppressions.delete(sessionID)
        }
        const owner = ownership.observeAssistant(info)
        if (info?.time?.completed) {
          const meaningful = consumeMeaningfulAssistant(info?.id)
          if (owner) {
            let emptyNotice: { count: number; paused: boolean } | undefined
            let accounted = false
            await serialize(sessionID, async () => {
              const result = await mutateGoal(store, sessionID, (goal) => {
                emptyNotice = undefined
                if (owner.goalID !== goal.id || goal.usage.seenMessageIDs.includes(info.id)) return null
                const sample = {
                  messageID: info.id,
                  inputTokens: info.tokens?.input,
                  outputTokens: info.tokens?.output,
                  reasoningTokens: info.tokens?.reasoning,
                  cost: info.cost,
                  createdAt: info.time?.created,
                  completedAt: info.time?.completed,
                }
                const currentRevision = sameGoalTurn(owner, goalTurnOwner(goal))
                let next: GoalState
                if (!meaningful && currentRevision && goal.status === "active") {
                  next = recordEmptyAssistantTurn(goal, sample)
                  emptyNotice = { count: next.emptyTurnCount ?? 0, paused: next.status === "paused" }
                } else {
                  next = accountAssistantUsage(goal, sample)
                  if (meaningful && currentRevision) next = clearEmptyAssistantTurnStreak(next)
                }
                return observeModelContextUsage(next, info.tokens)
              })
              accounted = Boolean(result?.wrote)
            })
            if (accounted && emptyNotice) {
              const message = emptyNotice.paused
                ? `Goal paused after ${emptyNotice.count} consecutive empty assistant turns.`
                : "Goal assistant returned no meaningful activity; retrying once."
              await showGoalToast(client, message, "warning")
            }
          }
        }
        return
      }
      if (type === "message.part.updated") {
        const part = properties.part
        if (assistantPartHasMeaningfulActivity(part)) rememberMeaningfulAssistant(part?.messageID)
        if (part?.type === "tool") {
          ownership.observeToolPart(sessionID, part)
          return
        }
        if (part?.type !== "patch" || typeof part.hash !== "string" || !part.hash) return
        if (toolProgressMessages.has(part.messageID)) return
        const owner = ownership.assistantOwner(part.messageID)
        if (!owner) return
        let madeProgress = false
        await serialize(sessionID, async () => {
          const result = await mutateGoal(store, sessionID, (goal) => {
            if (goal.status !== "active" || !sameGoalTurn(owner, goalTurnOwner(goal))) return null
            const files = Array.isArray(part.files) ? part.files.map(String).filter(Boolean) : []
            const next = markHostProgress(goal, {
              fingerprint: `patch:${part.hash}`,
              source: "patch",
              summary: files.length ? `Workspace changed: ${files.join(", ")}` : `Workspace patch ${part.hash}`,
            })
            madeProgress = next.progressRevision !== goal.progressRevision
            if (madeProgress && requiresDistinctGoalTurnCadence(goal) && !cadenceMutationReservations.has(sessionID)) {
              cadenceMutationReservations.set(sessionID, `patch:${part.messageID || part.hash}`)
            }
            return next
          })
          if (result?.wrote && madeProgress) notifyGoal(directory, result.goal, "progress")
        })
        return
      }
      if (type === "session.idle") {
        if (consumeSteeringIdle(sessionID)) return
        await continueIfActive(sessionID)
      }
    },

    tool: {
      opencode_goal_verifier_result: semanticVerifier.resultTool,
      opencode_goal_get: tool({
        description: "Read the current persistent goal and its verification state.",
        args: {},
        execute: async (_args: any, context: any) => formatStatus(await load(context.sessionID)),
      }),
      opencode_goal_progress: tool({
        description: "Record a checkpoint note. This does not count as verified progress by itself.",
        args: {
          summary: tool.schema.string(),
          next: tool.schema.string().optional(),
        },
        execute: async (args: any, context: any) => await serialize(context.sessionID, async () => {
          const goal = await load(context.sessionID)
          if (!goal) return "No active goal."
          const stale = staleToolReason(context, goal)
          if (stale) return stale
          const result = await mutateGoal(store, context.sessionID, (latest) => {
            if (latest.id !== goal.id || latest.revision !== goal.revision) return null
            if (staleToolReason(context, latest)) return null
            return addProgressNote(latest, args)
          })
          if (!result?.wrote) return "Rejected: the Goal changed before the checkpoint was recorded."
          return "Checkpoint recorded. Note: checkpoint text is not completion evidence."
        }),
      }),
      opencode_goal_evidence_file: tool({
        description: "Ask the host to verify a predeclared project-file requirement. Use either the exact requirement ID or the 1-based requirement number shown by opencode_goal_get/status; semantic/objective requirements are verified by completion audit instead.",
        args: { requirementID: tool.schema.string() },
        execute: async (args: any, context: any) => await serialize(context.sessionID, async () => {
          const goal = await load(context.sessionID)
          if (!goal) return "No active goal."
          const stale = staleToolReason(context, goal)
          if (stale) return stale
          let summary: string | undefined
          const result = await mutateGoal(store, context.sessionID, async (latest) => {
            if (latest.id !== goal.id || latest.revision !== goal.revision) return null
            if (staleToolReason(context, latest)) return null
            const checked = await recordFileEvidence(latest, { root: directory, requirementID: args.requirementID })
            summary = checked.evidence.summary
            return checked.evidence.passed ? proveRequirementsFromEvidence(checked.goal, checked.evidence.id) : checked.goal
          })
          if (!result?.wrote || summary === undefined) return "Rejected: the Goal changed before file evidence could be recorded."
          return summary
        }),
      }),
      opencode_goal_complete: tool({
        description: "Attempt verified completion. Host contracts run independently and semantic requirements are audited by a read-only verifier. Completion fails closed. If verifier infrastructure is unavailable, the Goal is paused instead of retry-looping.",
        args: { summary: tool.schema.string() },
        execute: async (args: any, context: any) => {
          const startingSteeringEpoch = currentSteeringEpoch(context.sessionID)
          const snapshot = await serialize(context.sessionID, async () => await load(context.sessionID))
          if (!snapshot) return "No active goal."
          const stale = staleToolReason(context, snapshot)
          if (stale) return stale
          if (snapshot.status !== "active") return `Completion rejected: goal status is ${snapshot.status}.`
          if ((snapshot.completionMode ?? "verified") === "continuous") {
            return "Completion disabled: this Goal is continuous. Keep working until the user pauses/clears it or a safety boundary stops it; use /goal edit <objective> --verified to re-enable verified completion."
          }
          const verifiedIdentity = completionSnapshotIdentity(snapshot)
          let evaluated = await runConfiguredChecks(snapshot, directory)
          evaluated = await verifyDeclaredFiles(evaluated, directory)
          if (currentSteeringEpoch(context.sessionID) !== startingSteeringEpoch) {
            return "Completion rejected: user steering arrived while host verification was running. Goal remains active."
          }
          try {
            evaluated = await semanticVerifier.verify(context.sessionID, evaluated, {
              ...(typeof context.messageID === "string" ? { currentMessageID: context.messageID } : {}),
            })
          } catch (error) {
            if (currentSteeringEpoch(context.sessionID) !== startingSteeringEpoch) {
              return "Completion not verified: user steering arrived while semantic verification was running. Goal remains active."
            }
            if (error instanceof SemanticVerifierUnavailableError) {
              return await serialize(context.sessionID, async () => {
                if (currentSteeringEpoch(context.sessionID) !== startingSteeringEpoch) {
                  return "Completion not verified: user steering arrived while semantic verification was running. Goal remains active."
                }
                const reason = `Independent semantic verification unavailable: ${error.message}`
                const result = await mutateGoal(store, context.sessionID, (latest) => {
                  if (latest.id !== snapshot.id || latest.revision !== snapshot.revision || latest.status !== "active") return null
                  const merged = completionSnapshotIdentity(latest) === verifiedIdentity
                    ? settleCurrentProgress(mergeAuditEvaluation(latest, evaluated))
                    : latest
                  return pauseGoal(merged, reason)
                })
                if (!result?.wrote) {
                  return "Completion not verified: goal changed, paused, or stopped while semantic verification was unavailable."
                }
                return `Completion not verified: ${error.message}. Goal paused to prevent repeated verifier retries. Use /goal resume to retry after the verifier/provider recovers.`
              })
            }
            return `Completion rejected: independent semantic verification failed closed (${String(error)}).`
          }
          return await serialize(context.sessionID, async () => {
            if (currentSteeringEpoch(context.sessionID) !== startingSteeringEpoch) {
              return "Completion rejected: user steering arrived while verification was running. Goal remains active."
            }
            let completed: ReturnType<typeof completeGoal> | undefined
            const result = await mutateGoal(store, context.sessionID, async (latest) => {
              if (latest.id !== snapshot.id || latest.revision !== snapshot.revision || latest.status !== "active") return null
              if (completionSnapshotIdentity(latest) !== verifiedIdentity) return null
              const refreshedFiles = await verifyDeclaredFiles(latest, directory)
              if (fileRequirementOutcomes(refreshedFiles) !== fileRequirementOutcomes(evaluated)) return null
              const merged = settleCurrentProgress(mergeAuditEvaluation(latest, evaluated))
              completed = completeGoal(merged, args.summary)
              return completed.goal
            })
            const audit = completed?.audit
            if (!result?.wrote || !audit) {
              return "Completion rejected: goal changed, paused, or stopped while verification was running."
            }
            const rejection = completionNotificationReason(result.goal, audit)
            if (rejection) notifyGoal(directory, result.goal, rejection)
            return audit.ok ? "Goal completed with host and verifier-backed evidence." : `Completion rejected:\n- ${audit.reasons.join("\n- ")}`
          })
        },
      }),
      opencode_goal_wait_for_user: tool({
        description: "Put the active Goal to sleep when required progress genuinely depends on new user input, approval, credentials, production/manual action, or external data the agent cannot obtain. Use this instead of repeatedly polling the same unchanged dependency. The Goal stays persisted and does not auto-continue until the user resumes it.",
        args: {
          reason: tool.schema.string(),
          needed: tool.schema.string().optional(),
        },
        execute: async (args: any, context: any) => await serialize(context.sessionID, async () => {
          const goal = await load(context.sessionID)
          if (!goal) return "No active goal."
          const stale = staleToolReason(context, goal)
          if (stale) return stale
          if (goal.status !== "active") return `Waiting-user rejected: goal status is ${goal.status}.`
          const result = await mutateGoal(store, context.sessionID, (latest) => {
            if (latest.id !== goal.id || latest.revision !== goal.revision || latest.status !== "active") return null
            if (staleToolReason(context, latest)) return null
            return waitForUserGoal(latest, args)
          })
          if (!result?.wrote) return "Waiting-user rejected: the Goal changed before it could be persisted."
          return "Goal is waiting for user input. End this assistant turn without more project work or polling; autonomous Goal continuation is asleep until the user resumes it."
        }),
      }),
      opencode_goal_blocked: tool({
        description: "Report a genuine blocker. The same blocker must recur on three distinct goal turns before the goal becomes blocked.",
        args: {
          reason: tool.schema.string(),
          needed: tool.schema.string().optional(),
          key: tool.schema.string().optional(),
        },
        execute: async (args: any, context: any) => await serialize(context.sessionID, async () => {
          const goal = await load(context.sessionID)
          if (!goal) return "No active goal."
          const stale = staleToolReason(context, goal)
          if (stale) return stale
          const result = await mutateGoal(store, context.sessionID, (latest) => {
            if (latest.id !== goal.id || latest.revision !== goal.revision) return null
            if (staleToolReason(context, latest)) return null
            return reportBlocker(latest, { turnID: context.messageID ?? context.callID ?? String(Date.now()), ...args })
          })
          if (!result?.wrote) return "Rejected: the Goal changed before the blocker was recorded."
          const count = result.goal.blockerAudit?.consecutiveTurns ?? 0
          return result.goal.status === "blocked"
            ? `Goal blocked after ${count} repeated blocker turns.`
            : `Blocker recorded (${count}/3). Keep working on other useful paths if possible.`
        }),
      }),
    },
  }
}
