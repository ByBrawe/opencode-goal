import { tool } from "@opencode-ai/plugin/tool"
import { createGoal, editGoal, pauseGoal, resumeGoal } from "../domain/goal.js"
import type { GoalExecutionContext, GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { accountAssistantUsage } from "../runtime/accounting.js"
import { reportBlocker } from "../runtime/blocker.js"
import { runConfiguredChecks } from "../runtime/checks.js"
import { addProgressNote, closeObservedTurn, markHostProgress } from "../runtime/progress.js"
import { completeGoal } from "../verification/audit.js"
import { verifyDeclaredFiles } from "../verification/contracts.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "../verification/evidence.js"
import { parseGoalCommand } from "./command.js"
import { TurnOwnership, goalTurnOwner, sameGoalTurn } from "./ownership.js"
import { compactionContext, continuationPrompt } from "./prompt.js"
import { createSemanticVerifierRuntime } from "./verifier.js"

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function formatStatus(goal: GoalState | null): string {
  if (!goal) return "No active goal."
  const req = goal.requirements.map((item, i) => `${i + 1}. [${item.status}] ${item.text}`).join("\n")
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nUsage: ${goal.usage.turns} turns, ${goal.usage.tokens} tokens, cost ${goal.usage.cost.toFixed(4)}\nRequirements:\n${req}`
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

export default async function OpenCodeGoalPlugin(input: any) {
  const { client, directory } = input
  const store = new GoalStore(directory)
  const semanticVerifier = createSemanticVerifierRuntime(client, directory)
  const ownership = new TurnOwnership()
  const dispatching = new Map<string, number>()
  const deferredIdle = new Set<string>()
  const steeringIdleSuppressions = new Map<string, number>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const sessionContexts = new Map<string, GoalExecutionContext>()

  function serialize<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    sessionLocks.set(sessionID, next)
    return next.finally(() => { if (sessionLocks.get(sessionID) === next) sessionLocks.delete(sessionID) })
  }

  async function load(sessionID: string) { return await store.load(sessionID) }
  async function save(goal: GoalState) { await store.save(goal); return goal }

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
          if (goal) goal = await save(pauseGoal(goal))
          if (ownership.activeOwner(event.sessionID)) abortControl = "pause"
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, `${formatStatus(goal)}\nRespond only with OK.`)
          return
        }
        if (parsed.action === "resume") {
          if (goal) goal = await save(resumeGoal(goal))
          markCommandOutputOwned(event.sessionID, output, goal ? continuationPrompt(goal) : "No goal exists. Respond only with that fact.", goal ?? undefined)
          return
        }
        if (parsed.action === "clear") {
          if (ownership.activeOwner(event.sessionID)) abortControl = "pause"
          await store.clear(event.sessionID)
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, "Goal cleared. Respond only with OK.")
          return
        }
        if (!parsed.objective) throw new Error("Usage: /goal <objective> [--accept \"criterion\"] [--check \"command\"]")
        const execution = sessionContexts.get(event.sessionID)
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
          if (sameGoalTurn(ownership.activeOwner(event.sessionID), previousOwner)) abortControl = "edit"
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
              await save({ ...goal, execution: context, updatedAt: Date.now() })
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
            await save(accountAssistantUsage(goal, {
              messageID: info.id,
              inputTokens: info.tokens?.input,
              outputTokens: info.tokens?.output,
              reasoningTokens: info.tokens?.reasoning,
              cost: info.cost,
              createdAt: info.time?.created,
              completedAt: info.time?.completed,
            }))
          })
        }
        return
      }
      if (type === "message.part.updated") {
        const part = properties.part
        if (part?.type !== "patch" || typeof part.hash !== "string" || !part.hash) return
        const owner = ownership.assistantOwner(part.messageID)
        if (!owner) return
        await serialize(sessionID, async () => {
          const goal = await load(sessionID)
          if (!goal || goal.status !== "active" || !sameGoalTurn(owner, goalTurnOwner(goal))) return
          const files = Array.isArray(part.files) ? part.files.map(String).filter(Boolean) : []
          await save(markHostProgress(goal, {
            fingerprint: `patch:${part.hash}`,
            source: "patch",
            summary: files.length ? `Workspace changed: ${files.join(", ")}` : `Workspace patch ${part.hash}`,
          }))
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
        description: "Ask the host to verify a predeclared project-file requirement.",
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
        description: "Attempt verified completion. Host contracts run independently and semantic requirements are audited by a read-only verifier. Completion fails closed.",
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
            evaluated = await semanticVerifier.verify(context.sessionID, evaluated)
          } catch (error) {
            return `Completion rejected: independent semantic verification failed closed (${String(error)}).`
          }
          return await serialize(context.sessionID, async () => {
            const latest = await load(context.sessionID)
            if (!latest || latest.id !== snapshot.id || latest.revision !== snapshot.revision || latest.status !== "active") {
              return "Completion rejected: goal changed, paused, or stopped while verification was running."
            }
            const latestEvidenceIDs = new Set(latest.evidence.map((item) => item.id))
            const merged: GoalState = {
              ...latest,
              requirements: evaluated.requirements,
              evidence: [...latest.evidence, ...evaluated.evidence.filter((item) => !latestEvidenceIDs.has(item.id))].slice(-500),
              progressRevision: Math.max(latest.progressRevision, evaluated.progressRevision),
              updatedAt: Date.now(),
            }
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
