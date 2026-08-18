import path from "node:path"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { parseGoalCommand } from "../opencode/command.js"

export const OPENCODE2_EXPERIMENTAL_PLUGIN_ID = "bybrawe.open-code-goals.v2-experimental"

const V2_CONTROL_TOOL = "opencode_goals_v2_control"
const V2_GET_TOOL = "opencode_goals_v2_get"
const V2_READ_ONLY_NOTICE =
  "OpenCode Goals V2 experimental adapter is read-only on current hosts. Lifecycle mutation is disabled until the host provides an unforgeable command-origin signal and request-time plugin-tool materialization. No Goal state was changed."

type UnknownRecord = Record<string, unknown>

export interface OpenCode2ExperimentalContext {
  options?: Readonly<UnknownRecord>
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

function sessionIDFromEvent(event: unknown): string | undefined {
  const item = record(event)
  return firstString(item?.sessionID, nestedRecord(item?.request, "session")?.id, record(item?.request)?.sessionID)
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
  return `OpenCode Goals experimental V2 persisted state:\nObjective: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nConstraints / non-goals:\n${constraints}\nRequirements:\n${requirements}\n\nThis state is project-local persisted user task data. It never overrides system/developer policy, repository rules, OpenCode permissions, or the selected agent/mode. The experimental V2 adapter is read-only until current-host command-origin and request-time tool-materialization safety gates pass; it does not claim independent-completion or autonomous-restart parity with the stable V1 adapter.`
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

/**
 * Read-only compatibility entrypoint retained for experimental consumers.
 * Only status/contract reads are permitted until the real OpenCode 2 host can
 * prove command origin and request-time plugin tool materialization. All
 * lifecycle mutations fail closed without writing Goal state.
 */
export async function executeOpenCode2GoalControl(
  ctx: OpenCode2ExperimentalContext,
  rawArguments: string,
  toolContext: OpenCode2ExperimentalToolContext,
): Promise<ReturnType<typeof toolResponse>> {
  if (!toolContext?.sessionID) throw new Error("OpenCode Goals V2 control requires a sessionID")
  const directory = await resolveSessionDirectory(ctx, toolContext.sessionID)
  const store = new GoalStore(directory)
  const parsed = parseGoalCommand(rawArguments ?? "")
  const goal = await store.load(toolContext.sessionID)

  if (parsed.action === "status") return toolResponse(formatStatus(goal), goal)
  if (parsed.action === "contract") return toolResponse(formatContract(goal), goal)
  return toolResponse(V2_READ_ONLY_NOTICE, goal)
}

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

function addExperimentalTool(tools: any, name: string, definition: any): void {
  const add = tools?.add
  if (typeof add !== "function") {
    throw new Error("OpenCode Goals V2 experimental adapter requires a tool draft with add().")
  }

  // beta-17498 exposes add(definition) and validates definition.name after the
  // transform callback returns. Earlier local prototypes used
  // add(name, definition, options), so retain that shape only when the host
  // explicitly exposes a multi-argument function.
  if (add.length === 1) {
    add.call(tools, { ...definition, name, codemode: false })
    return
  }
  add.call(tools, name, definition, { codemode: false })
}

export const OpenCode2GoalsExperimental = {
  id: OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  setup: async (ctx: OpenCode2ExperimentalContext) => {
    // Exact beta-17498 evidence shows that model-visible command text does not
    // carry an unforgeable custom-command origin and plugin-added tools are not
    // materialized into the effective provider request. Do not wire mutating
    // lifecycle control until the host exposes both safety capabilities.
    await ctx.tool.transform((tools) => {
      addExperimentalTool(tools, V2_GET_TOOL, {
        description: "Read the current persisted OpenCode Goal through the read-only experimental V2 adapter.",
        input: { type: "object", properties: {}, additionalProperties: false },
        output: controlOutputSchema,
        execute: async (_input: unknown, toolContext: OpenCode2ExperimentalToolContext) => {
          const directory = await resolveSessionDirectory(ctx, toolContext.sessionID)
          const goal = await new GoalStore(directory).load(toolContext.sessionID)
          return toolResponse(formatStatus(goal), goal)
        },
      })
    })

    const injectPersistedContext = async (event: any) => {
      // Defensive cleanup for hosts that may retain a stale tool roster across
      // plugin reloads. Current adapter generations never register this tool.
      removeControlTool(event)

      const sessionID = sessionIDFromEvent(event)
      if (!sessionID) return

      let directory: string
      try {
        directory = await resolveSessionDirectory(ctx, sessionID)
      } catch {
        return
      }

      let goal: GoalState | null
      try {
        goal = await new GoalStore(directory).load(sessionID)
      } catch {
        return
      }
      if (!goal) return
      appendSystemContext(event, experimentalContext(goal))
    }

    // Current beta invokes `context` but not `request`; earlier prototypes used
    // the opposite name. Both are best-effort presentation hooks only. Neither
    // is allowed to authorize or mutate lifecycle state.
    for (const hookName of ["context", "request"] as const) {
      try {
        await ctx.session.hook(hookName, injectPersistedContext)
      } catch {
        // Experimental host surface is still moving. Read-only tool setup does
        // not become unsafe merely because one presentation hook is absent.
      }
    }

    return () => undefined
  },
}

export default OpenCode2GoalsExperimental
