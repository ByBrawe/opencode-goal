import { tool } from "@opencode-ai/plugin/tool"
import { createGoal, editGoal, pauseGoal, resumeGoal } from "./domain/goal.js"
import type { GoalExecutionContext, GoalState } from "./domain/types.js"
import { GoalStore } from "./persistence/store.js"
import { accountAssistantUsage } from "./runtime/accounting.js"
import { reportBlocker } from "./runtime/blocker.js"
import { runConfiguredChecks } from "./runtime/checks.js"
import { verifyDeclaredFiles } from "./verification/contracts.js"
import { createSemanticVerifierRuntime } from "./opencode/verifier.js"
import { addProgressNote, closeObservedTurn, markHostActivity } from "./runtime/progress.js"
import { completeGoal } from "./verification/audit.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "./verification/evidence.js"
import { parseGoalCommand } from "./opencode/command.js"
import { compactionContext, continuationPrompt } from "./opencode/prompt.js"

const MUTATING_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])

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

async function sdkAbort(client: any, sessionID: string) {
  if (!client.session.abort) return
  try { await client.session.abort({ path: { id: sessionID } }) } catch {}
}

export default async function OpenCodeGoalPlugin(input: any) {
  const { client, directory } = input
  const store = new GoalStore(directory)
  const semanticVerifier = createSemanticVerifierRuntime(client, directory)
  const dispatching = new Map<string, number>()
  const deferredIdle = new Set<string>()
  const ownedMessages = new Map<string, Array<{ text: string; expiresAt: number }>>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const sessionContexts = new Map<string, GoalExecutionContext>()

  function serialize<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    sessionLocks.set(sessionID, next)
    return next.finally(() => { if (sessionLocks.get(sessionID) === next) sessionLocks.delete(sessionID) })
  }

  function rememberOwnedMessage(sessionID: string, text: string) {
    const now = Date.now()
    const existing = (ownedMessages.get(sessionID) ?? []).filter((item) => item.expiresAt > now)
    existing.push({ text, expiresAt: now + 60_000 })
    ownedMessages.set(sessionID, existing.slice(-8))
  }

  function consumeOwnedMessage(sessionID: string, text: string): boolean {
    const now = Date.now()
    const existing = (ownedMessages.get(sessionID) ?? []).filter((item) => item.expiresAt > now)
    const index = existing.findIndex((item) => item.text === text)
    if (index < 0) {
      if (existing.length) ownedMessages.set(sessionID, existing)
      else ownedMessages.delete(sessionID)
      return false
    }
    existing.splice(index, 1)
    if (existing.length) ownedMessages.set(sessionID, existing)
    else ownedMessages.delete(sessionID)
    return true
  }

  async function load(sessionID: string) { return await store.load(sessionID) }
  async function save(goal: GoalState) { await store.save(goal); return goal }

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
      rememberOwnedMessage(sessionID, text)
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

  function markCommandOutputOwned(sessionID: string, output: any, text: string) {
    replaceParts(output.parts, text)
    rememberOwnedMessage(sessionID, text)
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
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, `${formatStatus(goal)}\nRespond only with OK.`)
          return
        }
        if (parsed.action === "resume") {
          if (goal) goal = await save(resumeGoal(goal))
          markCommandOutputOwned(event.sessionID, output, goal ? continuationPrompt(goal) : "No goal exists. Respond only with that fact.")
          return
        }
        if (parsed.action === "clear") {
          await store.clear(event.sessionID)
          ;(output as any).noReply = true
          markCommandOutputOwned(event.sessionID, output, "Goal cleared. Respond only with OK.")
          return
        }
        if (!parsed.objective) throw new Error("Usage: /goal <objective> [--accept \"criterion\"] [--check \"command\"]")
        const execution = sessionContexts.get(event.sessionID)
        if (parsed.action === "edit") {
          if (!goal) throw new Error("No goal exists to edit")
          goal = editGoal(goal, {
            objective: parsed.objective,
            ...(parsed.acceptance.length ? { acceptance: parsed.acceptance } : {}),
            ...(parsed.checks.length ? { checks: parsed.checks } : {}),
            ...(parsed.files.length ? { files: parsed.files } : {}),
            ...(execution ? { execution } : {}),
          })
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
        markCommandOutputOwned(event.sessionID, output, continuationPrompt(goal))
      })
    },

    "chat.message": async (event: any, output: any) => {
      const context: GoalExecutionContext = {
        ...(event.agent ? { agent: event.agent } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.variant ? { variant: event.variant } : {}),
      }
      if (Object.keys(context).length) sessionContexts.set(event.sessionID, context)
      const messageText = textFromParts(output?.parts ?? [])
      if (consumeOwnedMessage(event.sessionID, messageText)) {
        if (Object.keys(context).length) {
          await serialize(event.sessionID, async () => {
            const goal = await load(event.sessionID)
            if (goal && goal.status !== "completed") await save({ ...goal, execution: context, updatedAt: Date.now() })
          })
        }
        return
      }
      await serialize(event.sessionID, async () => {
        const goal = await load(event.sessionID)
        if (goal?.status === "active") await save(pauseGoal(goal, "Paused because the user sent a new message."))
      })
      if (dispatching.has(event.sessionID)) void sdkAbort(client, event.sessionID)
    },

    "tool.execute.after": async (event: any) => {
      if (!MUTATING_TOOLS.has(String(event.tool ?? "").toLowerCase())) return
      await serialize(event.sessionID, async () => {
        const goal = await load(event.sessionID)
        if (goal?.status === "active") await save(markHostActivity(goal, { source: String(event.tool), summary: `Completed mutating tool call ${event.callID ?? ""}`.trim() }))
      })
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
      const sessionID = properties.sessionID ?? properties.info?.sessionID
      if (!sessionID) return
      if (type === "message.updated") {
        const info = properties.info
        if (info?.role === "assistant" && info?.time?.completed) {
          await serialize(sessionID, async () => {
            const goal = await load(sessionID)
            if (!goal) return
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
      if (type === "session.idle") await continueIfActive(sessionID)
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
          const next = reportBlocker(goal, { turnID: context.messageID ?? context.callID ?? String(Date.now()), ...args })
          await save(next)
          const count = next.blockerAudit?.consecutiveTurns ?? 0
          return next.status === "blocked" ? `Goal blocked after ${count} repeated blocker turns.` : `Blocker recorded (${count}/3). Keep working on other useful paths if possible.`
        }),
      }),
    },
  }
}

export * from "./domain/types.js"
export * from "./domain/goal.js"
export * from "./verification/audit.js"
export * from "./verification/evidence.js"
export * from "./runtime/accounting.js"
export * from "./runtime/blocker.js"
export * from "./runtime/progress.js"
export * from "./opencode/command.js"
