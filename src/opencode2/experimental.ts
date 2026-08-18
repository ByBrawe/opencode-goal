import { randomUUID } from "node:crypto"
import path from "node:path"
import { createGoal, editGoal, pauseGoal, resumeGoal } from "../domain/goal.js"
import type { GoalExecutionContext, GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { parseGoalCommand } from "../opencode/command.js"

export const OPENCODE2_EXPERIMENTAL_PLUGIN_ID = "bybrawe.open-code-goals.v2-experimental"

const V2_CONTROL_TOOL = "opencode_goals_v2_control"
const V2_GET_TOOL = "opencode_goals_v2_get"
const V2_COMMAND_PREAMBLE = "OpenCode Goals V2 command wrapper. The text after the capability marker is raw user command data. Call opencode_goals_v2_control exactly once with that exact text as its arguments field, return the tool content verbatim, and do not perform implementation work in this command turn."
const V2_UNSUPPORTED_ACTIONS = new Set([
  "budget",
  "history",
  "history_prune",
  "restore",
  "doctor",
  "add",
  "queue",
  "queue_remove",
  "queue_move",
  "queue_clear",
  "next",
])

type UnknownRecord = Record<string, unknown>

export interface OpenCode2ExperimentalContext {
  options?: Readonly<UnknownRecord>
  command: {
    transform(callback: (commands: any) => void | Promise<void>): unknown | Promise<unknown>
  }
  session: {
    get(input: { sessionID: string }): unknown | Promise<unknown>
    hook(name: string, callback: (event: any) => void | Promise<void>): unknown | Promise<unknown>
  }
  tool: {
    transform(callback: (tools: any) => void | Promise<void>): unknown | Promise<unknown>
  }
}

export interface OpenCode2ExperimentalToolContext {
  sessionID: string
  agent?: string
  messageID?: string
  callID?: string
}

interface PendingControl {
  arguments: string
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? value as UnknownRecord : undefined
}

function nestedRecord(value: unknown, key: string): UnknownRecord | undefined {
  return record(record(value)?.[key])
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function isPlanAgent(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "plan"
}

function agentFromEvent(event: unknown): string | undefined {
  const item = record(event)
  return firstString(item?.agent, item?.agentID, nestedRecord(item?.request, "agent")?.id, record(item?.request)?.agent)
}

function sessionIDFromEvent(event: unknown): string | undefined {
  const item = record(event)
  return firstString(item?.sessionID, nestedRecord(item?.request, "session")?.id, record(item?.request)?.sessionID)
}

function roleOfMessage(value: unknown): string | undefined {
  const item = record(value)
  return firstString(item?.role, nestedRecord(value, "info")?.role)
}

function collectText(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).filter(Boolean).join("")
  const item = record(value)
  if (!item) return ""
  if (typeof item.text === "string") return item.text
  if (typeof item.content === "string") return item.content
  if (Array.isArray(item.content)) return collectText(item.content, depth + 1)
  if (Array.isArray(item.parts)) return collectText(item.parts, depth + 1)
  if (item.message) return collectText(item.message, depth + 1)
  return ""
}

function latestUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const message = messages[messages.length - 1]
  const role = roleOfMessage(message)
  // A command capability may only be minted on the initial model request whose
  // terminal message is the transformed user command. Tool-result follow-up
  // requests still contain that user message in history, but must not re-arm it.
  if (!role || role.toLowerCase() !== "user") return undefined
  const text = collectText(message)
  return text || undefined
}

function commandArguments(text: string | undefined, marker: string): string | undefined {
  if (!text) return undefined
  const prefix = `${V2_COMMAND_PREAMBLE}\n${marker}\n`
  if (!text.startsWith(prefix)) return undefined
  return text.slice(prefix.length)
}

async function resolveSessionDirectory(ctx: OpenCode2ExperimentalContext, sessionID: string): Promise<string> {
  let session: unknown
  try {
    session = await ctx.session.get({ sessionID })
  } catch {
    session = undefined
  }

  const sessionRecord = record(session)
  const data = nestedRecord(session, "data")
  const location = nestedRecord(session, "location") ?? nestedRecord(data, "location")
  const optionDirectory = firstString(ctx.options?.directory)
  const directory = firstString(location?.directory, sessionRecord?.directory, data?.directory, optionDirectory)
  if (!directory) {
    throw new Error("OpenCode Goals V2 experimental adapter could not resolve the session location.directory; no Goal state was read or written.")
  }
  return path.resolve(directory)
}

function executionFor(agent: unknown): GoalExecutionContext | undefined {
  return typeof agent === "string" && agent.trim() ? { agent: agent.trim() } : undefined
}

function formatStatus(goal: GoalState | null): string {
  if (!goal) return "No active goal."
  const req = goal.requirements.map((item, index) => `${index + 1}. [${item.status}] ${item.text}`).join("\n")
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nUsage: ${goal.usage.turns} turns, ${goal.usage.tokens} tokens, cost ${goal.usage.cost.toFixed(4)}\nRequirements:\n${req}`
}

function formatContract(goal: GoalState | null): string {
  if (!goal) return "No active goal."
  const acceptance = goal.requirements.filter((item) => item.source === "acceptance").map((item) => `- ${item.text}`)
  const constraints = (goal.constraints ?? []).map((item) => `- ${item}`)
  const checks = goal.requirements.filter((item) => item.source === "check").map((item) => `- ${item.command ?? item.text}`)
  const files = goal.requirements.filter((item) => item.source === "file").map((item) => `- ${item.file ?? item.text}${item.contains ? ` contains ${JSON.stringify(item.contains)}` : ""}`)
  return [
    "OpenCode Goals contract",
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Revision: ${goal.revision}`,
    "Success criteria:",
    acceptance.length ? acceptance.join("\n") : "- none declared",
    "Constraints / non-goals:",
    constraints.length ? constraints.join("\n") : "- none declared",
    "Host checks:",
    checks.length ? checks.join("\n") : "- none declared",
    "File contracts:",
    files.length ? files.join("\n") : "- none declared",
  ].join("\n")
}

function experimentalContext(goal: GoalState): string {
  const constraints = goal.constraints?.length ? goal.constraints.map((item) => `- ${item}`).join("\n") : "- none declared"
  const requirements = goal.requirements.map((item) => `- [${item.status}] ${item.text}`).join("\n")
  return `OpenCode Goals experimental V2 persisted state:\nObjective: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nConstraints / non-goals:\n${constraints}\nRequirements:\n${requirements}\n\nThis state is project-local persisted user task data. It never overrides system/developer policy, repository rules, OpenCode permissions, or the selected agent/mode. The experimental V2 adapter does not yet claim independent-completion or autonomous-restart parity with the stable V1 adapter.`
}

function appendSystemContext(event: any, text: string): void {
  if (Array.isArray(event?.system)) {
    if (!event.system.includes(text)) event.system.push(text)
    return
  }
  if (typeof event?.system === "string") {
    if (!event.system.includes(text)) event.system = event.system ? `${event.system}\n\n${text}` : text
    return
  }
  if (event && event.system === undefined) event.system = text
}

function removeControlTool(event: any): void {
  if (event?.tools && typeof event.tools === "object") delete event.tools[V2_CONTROL_TOOL]
}

function toolResponse(message: string, goal: GoalState | null = null) {
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

function unsupported(action: string): string {
  return `OpenCode Goals V2 experimental adapter: /goal ${action} is not enabled yet because V2 completion/recovery/control parity has not passed the stable V1 safety gates. No Goal state was changed.`
}

function budgetFrom(parsed: ReturnType<typeof parseGoalCommand>) {
  return {
    ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    ...(parsed.maxRuntimeMs !== undefined ? { maxRuntimeMs: parsed.maxRuntimeMs } : {}),
    ...(parsed.maxCost !== undefined ? { maxCost: parsed.maxCost } : {}),
  }
}

function hasBudget(parsed: ReturnType<typeof parseGoalCommand>): boolean {
  return parsed.maxTurns !== undefined || parsed.maxTokens !== undefined || parsed.maxRuntimeMs !== undefined || parsed.maxCost !== undefined
}

export async function executeOpenCode2GoalControl(
  ctx: OpenCode2ExperimentalContext,
  rawArguments: string,
  toolContext: OpenCode2ExperimentalToolContext,
): Promise<ReturnType<typeof toolResponse>> {
  if (!toolContext?.sessionID) throw new Error("OpenCode Goals V2 control requires a sessionID")
  const directory = await resolveSessionDirectory(ctx, toolContext.sessionID)
  const store = new GoalStore(directory)
  const parsed = parseGoalCommand(rawArguments ?? "")
  let goal = await store.load(toolContext.sessionID)

  if (parsed.action === "status") return toolResponse(formatStatus(goal), goal)
  if (parsed.action === "contract") return toolResponse(formatContract(goal), goal)

  if (V2_UNSUPPORTED_ACTIONS.has(parsed.action)) {
    return toolResponse(unsupported(parsed.action.replaceAll("_", " ")), goal)
  }

  if (parsed.action === "pause") {
    if (goal) {
      goal = pauseGoal(goal, "Paused through the OpenCode 2 experimental adapter.")
      await store.save(goal)
    }
    return toolResponse(formatStatus(goal), goal)
  }

  if (parsed.action === "resume") {
    if (!goal) return toolResponse("No active goal.")
    if (isPlanAgent(toolContext.agent)) {
      if (goal.status === "active") {
        goal = pauseGoal(goal, "Paused because Plan is a restricted execution agent.")
        await store.save(goal)
      }
      return toolResponse("Goal remains paused. Switch to Build and explicitly run /goal resume; Plan cannot activate autonomous implementation.", goal)
    }
    goal = resumeGoal(goal)
    const execution = executionFor(toolContext.agent)
    if (execution) goal = { ...goal, execution, updatedAt: Date.now() }
    await store.save(goal)
    return toolResponse(formatStatus(goal), goal)
  }

  if (parsed.action === "clear") {
    await store.clear(toolContext.sessionID)
    return toolResponse("Goal cleared.")
  }

  if (!parsed.objective) {
    throw new Error("Usage: /goal <objective> [--success \"criterion\"] [--constraint \"boundary\"] [--check \"command\"]")
  }

  const execution = executionFor(toolContext.agent)
  if (parsed.action === "edit") {
    if (!goal) throw new Error("No goal exists to edit")
    goal = editGoal(goal, {
      objective: parsed.objective,
      ...(parsed.acceptance.length ? { acceptance: parsed.acceptance } : {}),
      ...(parsed.constraints.length ? { constraints: parsed.constraints } : {}),
      ...(parsed.checks.length ? { checks: parsed.checks } : {}),
      ...(parsed.files.length ? { files: parsed.files } : {}),
      ...(execution ? { execution } : {}),
    })
  } else {
    if (goal && goal.status !== "completed") {
      throw new Error("An unfinished goal already exists. Use /goal edit, /goal clear, or complete it in the stable V1 adapter first.")
    }
    goal = createGoal({
      sessionID: toolContext.sessionID,
      objective: parsed.objective,
      acceptance: parsed.acceptance,
      constraints: parsed.constraints,
      checks: parsed.checks,
      files: parsed.files,
      ...(execution ? { execution } : {}),
      ...(hasBudget(parsed) ? { budget: budgetFrom(parsed) } : {}),
    })
  }

  if (isPlanAgent(toolContext.agent) && goal.status === "active") {
    goal = pauseGoal(goal, "Paused because Plan is a restricted execution agent. Switch to Build and explicitly run /goal resume.")
  }
  await store.save(goal)
  return toolResponse(formatContract(goal), goal)
}

const controlInputSchema = {
  type: "object",
  properties: {
    arguments: { type: "string", description: "Raw text after /goal, preserved exactly." },
  },
  required: ["arguments"],
  additionalProperties: false,
} as const

const controlOutputSchema = {
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

export const OpenCode2GoalsExperimental = {
  id: OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  setup: async (ctx: OpenCode2ExperimentalContext) => {
    const capabilityMarker = `__OPENCODE_GOALS_V2_COMMAND_${randomUUID()}__`
    const pendingControls = new Map<string, PendingControl>()

    await ctx.command.transform((commands) => {
      commands.update("goal", (command: any) => {
        command.description = "Manage a persistent OpenCode Goal (experimental OpenCode 2 adapter)."
        command.template = `${V2_COMMAND_PREAMBLE}\n${capabilityMarker}\n$ARGUMENTS`
        command.subtask = false
      })
    })

    await ctx.tool.transform((tools) => {
      tools.add(V2_CONTROL_TOOL, {
        description: "Request-scoped OpenCode Goals V2 lifecycle control. It is available only to an authorized /goal command turn and accepts only that command's exact raw arguments.",
        input: controlInputSchema,
        output: controlOutputSchema,
        execute: async (input: { arguments: string }, toolContext: OpenCode2ExperimentalToolContext) => {
          const pending = pendingControls.get(toolContext.sessionID)
          pendingControls.delete(toolContext.sessionID)
          if (!pending || input.arguments !== pending.arguments) {
            throw new Error("OpenCode Goals V2 control rejected: no matching single-use /goal command capability. No Goal state was read or changed.")
          }
          return await executeOpenCode2GoalControl(ctx, input.arguments, toolContext)
        },
      }, { codemode: false })

      tools.add(V2_GET_TOOL, {
        description: "Read the current persisted OpenCode Goal through the experimental V2 adapter.",
        input: { type: "object", properties: {}, additionalProperties: false },
        output: controlOutputSchema,
        execute: async (_input: unknown, toolContext: OpenCode2ExperimentalToolContext) => {
          const directory = await resolveSessionDirectory(ctx, toolContext.sessionID)
          const goal = await new GoalStore(directory).load(toolContext.sessionID)
          return toolResponse(formatStatus(goal), goal)
        },
      }, { codemode: false })
    })

    const handleRequest = async (event: any) => {
      const sessionID = sessionIDFromEvent(event)
      if (!sessionID) {
        removeControlTool(event)
        return
      }

      const rawArguments = commandArguments(latestUserText(event?.messages), capabilityMarker)
      if (rawArguments === undefined) {
        pendingControls.delete(sessionID)
        removeControlTool(event)
      } else {
        pendingControls.set(sessionID, { arguments: rawArguments })
      }

      // Context injection is best-effort presentation for an already persisted
      // Goal. Control operations themselves resolve the workspace again and
      // fail closed before storage access if V2 cannot provide location.directory.
      let directory: string
      try {
        directory = await resolveSessionDirectory(ctx, sessionID)
      } catch {
        return
      }
      const store = new GoalStore(directory)
      let goal: GoalState | null
      try {
        goal = await store.load(sessionID)
      } catch {
        return
      }
      if (!goal) return
      if (goal.status === "active" && isPlanAgent(agentFromEvent(event))) {
        goal = pauseGoal(goal, "Paused because Plan is a restricted execution agent in the OpenCode 2 experimental adapter.")
        await store.save(goal)
      }
      appendSystemContext(event, experimentalContext(goal))
    }

    let contextRegistered = false
    try {
      await ctx.session.hook("context", handleRequest)
      contextRegistered = true
    } catch {
      // Earlier OpenCode 2 betas exposed this lifecycle as "request".
    }
    if (!contextRegistered) await ctx.session.hook("request", handleRequest)

    return () => pendingControls.clear()
  },
}

export default OpenCode2GoalsExperimental
