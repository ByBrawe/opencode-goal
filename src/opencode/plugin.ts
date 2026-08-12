import { tool } from "@opencode-ai/plugin/tool"
import { createGoal, editGoal, pauseGoal, resumeGoal } from "../domain/goal.js"
import type { GoalExecutionContext, GoalState } from "../domain/types.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import { accountAssistantUsage } from "../runtime/accounting.js"
import { reportBlocker } from "../runtime/blocker.js"
import { CADENCE_BOUNDARY_MESSAGE, requiresDistinctGoalTurnCadence } from "../runtime/cadence.js"
import { runConfiguredChecks } from "../runtime/checks.js"
import { formatModelContext, observeModelContextLimits, observeModelContextUsage } from "../runtime/model-context.js"
import { collectMutationFingerprints } from "../runtime/mutation-progress.js"
import { addProgressNote, closeObservedTurn, markHostProgress } from "../runtime/progress.js"
import { normalizeNativeTodos, observeTodoPlan } from "../runtime/todo-plan.js"
import { completeGoal } from "../verification/audit.js"
import { verifyDeclaredFiles } from "../verification/contracts.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "../verification/evidence.js"
import { parseGoalCommand } from "./command.js"
import { TurnOwnership, goalTurnOwner, sameGoalTurn } from "./ownership.js"
import { compactionContext, continuationPrompt } from "./prompt.js"
import { createSemanticVerifierRuntime, SemanticVerifierUnavailableError } from "./verifier.js"

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
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nGoal cumulative usage: ${goal.usage.turns} turns, ${goal.usage.tokens} tokens, cost ${goal.usage.cost.toFixed(4)}\nModel context: ${formatModelContext(goal)}\nRequirements:\n${req}`
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
  const store = new GoalStore(directory)
  const semanticVerifier = createSemanticVerifierRuntime(client, directory, {
    model: optionText(options.verifierModel) ?? optionText(process.env.OPENCODE_GOAL_VERIFIER_MODEL),
    timeoutMs: optionNumber(options.verifierTimeoutMs) ?? optionNumber(process.env.OPENCODE_GOAL_VERIFIER_TIMEOUT_MS),
  })
  const ownership = new TurnOwnership()
  const dispatching = new Map<string, number>()
  const deferredIdle = new Set<string>()
  const steeringIdleSuppressions = new Map<string, number>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const sessionContexts = new Map<string, GoalExecutionContext>()
  const toolProgressMessages = new Set<string>()
  const toolProgressOrder: string[] = []
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
      let goal = await load(sessionID)
      if (!goal || goal.status !== "active") return null
      goal = closeObservedTurn(goal)
      await save(goal)
      if (goal.status !== "active") return null
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
          const latest = await load(sessionID)
          if (latest?.status === "active" && dispatching.get(sessionID) === prepared.token) {
            await save(pauseGoal(latest, `Continuation dispatch failed: ${String(error)}`))
          }
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
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, "Goal cleared. Respond only with OK.")
          return
        }
        if (!parsed.objective) throw new Error("Usage: /goal <objective> [--accept \"criterion\"] [--check \"command\"]")
        const execution = sessionContexts.get(event.sessionID)
        resetCadenceTurn(event.sessionID)
        if (parsed.action === "edit") {
          if (!goal) throw new Error("No goal exists to edit")
          const previousOwner = goalTurnOwner(goal)
          goal = editGoal(goal, {
            objective: parsed.objective,
            ...(parsed.acceptance.length ? { acceptance: parsed.acceptance } : {}),
            ...(parsed.checks.length ? { checks: parsed.checks } : {}),
            ...(parsed.files.length ? { files: parsed.files } : {}),
            ...(execution ? { execution } : {}),
          })
          if (sameGoalTurn(ownership.activeOwner(event.sessionID), previousOwner) || dispatching.has(event.sessionID)) abortControl = "edit"
        } else {
          if (goal && goal.status !== "completed") throw new Error("An unfinished goal already exists. Use /goal edit, /goal clear, or complete it first.")
          goal = createGoal({
            sessionID: event.sessionID,
            objective: parsed.objective,
            acceptance: parsed.acceptance,
            checks: parsed.checks,
            files: parsed.files,
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
        if (owned.owner && Object.keys(context).length) {
          await serialize(event.sessionID, async () => {
            const goal = await load(event.sessionID)
            if (goal && goal.status !== "completed" && sameGoalTurn(owned.owner, goalTurnOwner(goal))) {
              await save({
                ...goal,
                execution: {
                  ...context,
                  ...(goal.execution?.modelContext ? { modelContext: goal.execution.modelContext } : {}),
                },
                updatedAt: Date.now(),
              })
            }
          })
        }
        return
      }
      await serialize(event.sessionID, async () => {
        const goal = await load(event.sessionID)
        if (goal?.status === "active") await save(pauseGoal(goal, "Paused because the user sent a new message."))
      })
      if (ownership.activeOwner(event.sessionID) || dispatching.has(event.sessionID)) await abortGoalTurn(event.sessionID, false)
    },

    "chat.params": async (event: any) => {
      await serialize(event.sessionID, async () => {
        const goal = await load(event.sessionID)
        if (!goal || goal.status === "completed") return
        const next = observeModelContextLimits(goal, {
          model: event.model,
          autoCompaction: hostAutoCompaction,
          ...(hostCompactionReserved !== undefined ? { compactionReserved: hostCompactionReserved } : {}),
        })
        if (next !== goal) await save(next)
      })
    },

    "tool.execute.before": async (event: any) => {
      if (event.tool === SHELL_TOOL) {
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
          const goal = await load(event.sessionID)
          if (!goal || goal.status !== "active" || !sameGoalTurn(call.owner, goalTurnOwner(goal))) return
          const next = observeTodoPlan(goal, todos)
          if (next === goal) return
          try {
            await save(next)
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
          let goal = await load(event.sessionID)
          if (!goal || goal.status !== "active" || !sameGoalTurn(call.owner, goalTurnOwner(goal))) return
          const before = goal.progressRevision
          for (const item of fingerprints) {
            goal = markHostProgress(goal, {
              fingerprint: item.fingerprint,
              source: `tool:${event.tool}`,
              summary: item.summary,
            })
          }
          if (goal.progressRevision !== before) {
            madeProgress = true
            rememberToolProgress(call.messageID)
            await save(goal)
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
        const owner = ownership.observeAssistant(info)
        if (info?.time?.completed && owner) {
          await serialize(sessionID, async () => {
            const goal = await load(sessionID)
            if (!goal || owner.goalID !== goal.id) return
            let next = accountAssistantUsage(goal, {
              messageID: info.id,
              inputTokens: info.tokens?.input,
              outputTokens: info.tokens?.output,
              reasoningTokens: info.tokens?.reasoning,
              cost: info.cost,
              createdAt: info.time?.created,
              completedAt: info.time?.completed,
            })
            next = observeModelContextUsage(next, info.tokens)
            await save(next)
          })
        }
        return
      }
      if (type === "message.part.updated") {
        const part = properties.part
        if (part?.type === "tool") {
          ownership.observeToolPart(sessionID, part)
          return
        }
        if (part?.type !== "patch" || typeof part.hash !== "string" || !part.hash) return
        if (toolProgressMessages.has(part.messageID)) return
        const owner = ownership.assistantOwner(part.messageID)
        if (!owner) return
        await serialize(sessionID, async () => {
          const goal = await load(sessionID)
          if (!goal || goal.status !== "active" || !sameGoalTurn(owner, goalTurnOwner(goal))) return
          const files = Array.isArray(part.files) ? part.files.map(String).filter(Boolean) : []
          const next = markHostProgress(goal, {
            fingerprint: `patch:${part.hash}`,
            source: "patch",
            summary: files.length ? `Workspace changed: ${files.join(", ")}` : `Workspace patch ${part.hash}`,
          })
          if (next.progressRevision !== goal.progressRevision && requiresDistinctGoalTurnCadence(goal) && !cadenceMutationReservations.has(sessionID)) {
            cadenceMutationReservations.set(sessionID, `patch:${part.messageID || part.hash}`)
          }
          await save(next)
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
          await save(addProgressNote(goal, args))
          return "Checkpoint recorded. Note: checkpoint text is not completion evidence."
        }),
      }),
      opencode_goal_evidence_file: tool({
        description: "Ask the host to verify a predeclared project-file requirement. Use only the exact ID of a requirement whose verification kind is file; semantic/objective requirements are verified by completion audit instead.",
        args: { requirementID: tool.schema.string() },
        execute: async (args: any, context: any) => await serialize(context.sessionID, async () => {
          let goal = await load(context.sessionID)
          if (!goal) return "No active goal."
          const stale = staleToolReason(context, goal)
          if (stale) return stale
          const checked = await recordFileEvidence(goal, { root: directory, requirementID: args.requirementID })
          goal = checked.goal
          if (checked.evidence.passed) goal = proveRequirementsFromEvidence(goal, checked.evidence.id)
          await save(goal)
          return checked.evidence.summary
        }),
      }),
      opencode_goal_complete: tool({
        description: "Attempt verified completion. Host contracts run independently and semantic requirements are audited by a read-only verifier. Completion fails closed. If verifier infrastructure is unavailable, the Goal is paused instead of retry-looping.",
        args: { summary: tool.schema.string() },
        execute: async (args: any, context: any) => {
          const snapshot = await serialize(context.sessionID, async () => await load(context.sessionID))
          if (!snapshot) return "No active goal."
          const stale = staleToolReason(context, snapshot)
          if (stale) return stale
          if (snapshot.status !== "active") return `Completion rejected: goal status is ${snapshot.status}.`
          let evaluated = await runConfiguredChecks(snapshot, directory)
          evaluated = await verifyDeclaredFiles(evaluated, directory)
          try {
            evaluated = await semanticVerifier.verify(context.sessionID, evaluated, {
              ...(typeof context.messageID === "string" ? { currentMessageID: context.messageID } : {}),
            })
          } catch (error) {
            if (error instanceof SemanticVerifierUnavailableError) {
              return await serialize(context.sessionID, async () => {
                const latest = await load(context.sessionID)
                if (!latest || latest.id !== snapshot.id || latest.revision !== snapshot.revision || latest.status !== "active") {
                  return "Completion not verified: goal changed, paused, or stopped while semantic verification was unavailable."
                }
                const merged = settleCurrentProgress(mergeAuditEvaluation(latest, evaluated))
                const reason = `Independent semantic verification unavailable: ${error.message}`
                await save(pauseGoal(merged, reason))
                return `Completion not verified: ${error.message}. Goal paused to prevent repeated verifier retries. Use /goal resume to retry after the verifier/provider recovers.`
              })
            }
            return `Completion rejected: independent semantic verification failed closed (${String(error)}).`
          }
          return await serialize(context.sessionID, async () => {
            const latest = await load(context.sessionID)
            if (!latest || latest.id !== snapshot.id || latest.revision !== snapshot.revision || latest.status !== "active") {
              return "Completion rejected: goal changed, paused, or stopped while verification was running."
            }
            const merged = settleCurrentProgress(mergeAuditEvaluation(latest, evaluated))
            const result = completeGoal(merged, args.summary)
            await save(result.goal)
            return result.audit.ok ? "Goal completed with host and verifier-backed evidence." : `Completion rejected:\n- ${result.audit.reasons.join("\n- ")}`
          })
        },
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
          const next = reportBlocker(goal, { turnID: context.messageID ?? context.callID ?? String(Date.now()), ...args })
          await save(next)
          const count = next.blockerAudit?.consecutiveTurns ?? 0
          return next.status === "blocked" ? `Goal blocked after ${count} repeated blocker turns.` : `Blocker recorded (${count}/3). Keep working on other useful paths if possible.`
        }),
      }),
    },
  }
}
