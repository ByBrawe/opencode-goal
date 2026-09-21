import path from "node:path"
import { createGoal, editGoal, pauseGoal, resumeGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { applyGoalBudget, budgetLimitHits } from "../runtime/accounting.js"
import { formatGoalRuntimeFingerprint } from "../runtime/fingerprint.js"
import { parseGoalCommand } from "../opencode/command.js"
import { createGoalTransitionNotifier } from "../opencode/notify.js"
import { continuationPrompt } from "../opencode/prompt.js"
import { isRestrictedGoalAgent, restrictedAgentStopReason } from "../opencode/agent-boundary.js"

export const OPENCODE2_EXPERIMENTAL_PLUGIN_ID = "bybrawe.open-code-goals.v2-experimental"

const V2_CONTROL_TOOL = "opencode_goals_v2_control"
const V2_GET_TOOL = "opencode_goals_v2_get"
export const OPENCODE2_DIRECT_LIFECYCLE_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const V2_READ_ONLY_NOTICE =
  "OpenCode Goals V2 model-visible lifecycle control remains read-only. Mutation is authorized only through the host-native direct command boundary when the explicit V2 lifecycle preview is enabled. No Goal state was changed."

type UnknownRecord = Record<string, unknown>

export interface OpenCode2ExperimentalContext {
  app?: {
    version?: string
  }
  options?: Readonly<UnknownRecord>
  command?: {
    transform(callback: (commands: any) => void | Promise<void>): unknown | Promise<unknown>
  }
  session: {
    get(input: { sessionID: string }): unknown | Promise<unknown>
    hook(name: string, callback: (event: any) => void | Promise<void>): unknown | Promise<unknown>
    prompt?(input: {
      sessionID: string
      id?: string
      text: string
      files?: readonly unknown[]
      agents?: readonly unknown[]
      skills?: readonly unknown[]
      metadata?: Readonly<UnknownRecord>
      delivery?: "steer" | "queue" | null
      resume?: boolean | null
    }): unknown | Promise<unknown>
    synthetic?(input: {
      sessionID: string
      id?: string
      text: string
      description?: string
      metadata?: Readonly<UnknownRecord>
      delivery?: "steer" | "queue" | null
      resume?: boolean | null
    }): unknown | Promise<unknown>
    interrupt?(input: { sessionID: string; resume?: boolean }): unknown | Promise<unknown>
  }
  tool: {
    transform(callback: (tools: any) => void | Promise<void>): unknown | Promise<unknown>
  }
}

export interface OpenCode2DirectCommandInvocation {
  sessionID: string
  prompt: {
    text: string
    files?: readonly unknown[]
    agents?: readonly unknown[]
    skills?: readonly unknown[]
  }
  delivery?: "steer" | "queue" | null
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

async function resolveSessionSnapshot(
  ctx: OpenCode2ExperimentalContext,
  sessionID: string,
): Promise<{ directory: string; agent?: string }> {
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
  const agent = firstString(sessionRecord?.agent, data?.agent)
  return {
    directory: path.resolve(directory),
    ...(agent ? { agent } : {}),
  }
}

async function resolveSessionDirectory(ctx: OpenCode2ExperimentalContext, sessionID: string): Promise<string> {
  return (await resolveSessionSnapshot(ctx, sessionID)).directory
}

function formatStatus(goal: GoalState | null): string {
  if (!goal) return "No active goal."
  const req = goal.requirements.map((item, index) => `${index + 1}. [${item.status}] ${item.text}`).join("\n")
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nRuntime: ${formatGoalRuntimeFingerprint(goal.runtimeFingerprint)}\nUsage: ${goal.usage.turns} turns, ${goal.usage.tokens} tokens, cost ${goal.usage.cost.toFixed(4)}\nRequirements:\n${req}`
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
  return `OpenCode Goals experimental V2 persisted state:\nObjective: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nConstraints / non-goals:\n${constraints}\nRequirements:\n${requirements}\n\nThis state is project-local persisted user task data. It never overrides system/developer policy, repository rules, OpenCode permissions, or the selected agent/mode. Model-visible V2 lifecycle mutation remains read-only. A separately gated host-native direct-command preview may mutate lifecycle state only when explicitly enabled; independent-completion and autonomous-restart parity are not yet claimed for the V2 adapter.`
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


const OPENCODE2_DIRECT_LIFECYCLE_HOST_VERSION = "2.0.11"

function directLifecyclePreviewRequested(): boolean {
  const value = String(process.env[OPENCODE2_DIRECT_LIFECYCLE_ENV] ?? "").trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function assertDirectLifecycleHost(ctx: OpenCode2ExperimentalContext): void {
  const version = firstString(ctx.app?.version)
  if (version !== OPENCODE2_DIRECT_LIFECYCLE_HOST_VERSION) {
    throw new Error(
      `OpenCode Goals V2 direct lifecycle preview is proven only on OpenCode ${OPENCODE2_DIRECT_LIFECYCLE_HOST_VERSION}; current host is ${version ?? "unknown"}. No mutating Goal command was registered.`,
    )
  }
}

function directBudgetPatch(parsed: ReturnType<typeof parseGoalCommand>) {
  return {
    ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    ...(parsed.maxRuntimeMs !== undefined ? { maxRuntimeMs: parsed.maxRuntimeMs } : {}),
    ...(parsed.maxCost !== undefined ? { maxCost: parsed.maxCost } : {}),
  }
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

function planBoundaryMessage(goal: GoalState, agent: string): string {
  return [
    `Goal saved but paused in ${agent} mode.`,
    `Objective: ${goal.objective}`,
    "Status: paused",
    "",
    "Planning-only boundary: continue analysis/planning only. Do not implement, edit files, or autonomously continue this Goal. Switch to Build and run /goal resume when implementation should begin.",
  ].join("\n")
}

function admittedMessageID(value: unknown): string | undefined {
  return firstString(record(value)?.id, nestedRecord(value, "data")?.id)
}

async function interruptDirectGoalTurn(ctx: OpenCode2ExperimentalContext, sessionID: string): Promise<void> {
  if (typeof ctx.session.interrupt !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle preview requires session.interrupt() before mutating an existing Goal.")
  }
  await ctx.session.interrupt({ sessionID, resume: false })
}

async function emitDirectGoalNotice(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
  text: string,
): Promise<void> {
  if (typeof ctx.session.synthetic !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle preview requires session.synthetic() for deterministic command output.")
  }
  await ctx.session.synthetic({
    sessionID: input.sessionID,
    text,
    description: "OpenCode Goal",
    metadata: { opencode_goal_v2_direct_command: true, opencode_goal_v2_notice: true },
    delivery: input.delivery ?? "steer",
    resume: false,
  })
}

async function dispatchDirectGoalContinuation(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
  text: string,
): Promise<string> {
  if (typeof ctx.session.prompt !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle preview requires session.prompt().")
  }
  const base = {
    sessionID: input.sessionID,
    text,
    files: input.prompt?.files,
    agents: input.prompt?.agents,
    skills: input.prompt?.skills,
    metadata: { opencode_goal_v2_direct_command: true, opencode_goal_v2_continuation: true },
    delivery: input.delivery ?? "steer",
  } as const
  const admitted = await ctx.session.prompt({ ...base, resume: false })
  const messageID = admittedMessageID(admitted)
  if (!messageID) {
    throw new Error("OpenCode Goals V2 direct lifecycle preview did not receive a host-generated continuation message id.")
  }
  const resumed = await ctx.session.prompt({ ...base, id: messageID, resume: true })
  const resumedID = admittedMessageID(resumed)
  if (resumedID && resumedID !== messageID) {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview resumed a different message id (${resumedID}) than it admitted (${messageID}).`)
  }
  return messageID
}

async function dispatchContinuationOrPause(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
  store: GoalStore,
  goal: GoalState,
): Promise<void> {
  try {
    await dispatchDirectGoalContinuation(ctx, input, continuationPrompt(goal))
  } catch (error) {
    const latest = await store.load(input.sessionID)
    if (
      latest
      && latest.id === goal.id
      && latest.revision === goal.revision
      && latest.status === "active"
    ) {
      await store.save(pauseGoal(latest, `OpenCode 2 continuation dispatch failed: ${String(error)}`))
    }
    try {
      await emitDirectGoalNotice(
        ctx,
        input,
        `Goal paused because OpenCode 2 could not dispatch its continuation: ${String(error)}`,
      )
    } catch {
      // The original transport error is authoritative; a notice failure cannot
      // turn a fail-closed paused Goal back into active execution.
    }
    throw error
  }
}

const DIRECT_LIFECYCLE_ACTIONS = new Set(["create", "edit", "pause", "resume", "clear", "status", "contract"])

function requireDirectLifecycleCapabilities(
  ctx: OpenCode2ExperimentalContext,
  action: ReturnType<typeof parseGoalCommand>["action"],
): void {
  if (typeof ctx.session.synthetic !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview requires session.synthetic() before /goal ${action} can run.`)
  }
  if (["create", "edit", "resume"].includes(action) && typeof ctx.session.prompt !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview requires session.prompt() before /goal ${action} can run.`)
  }
  if (["edit", "pause", "clear"].includes(action) && typeof ctx.session.interrupt !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview requires session.interrupt() before /goal ${action} can run.`)
  }
}

function requireExecutionAgent(action: string, agent: string | undefined): string {
  if (agent) return agent
  throw new Error(`OpenCode Goals V2 direct lifecycle preview could not resolve the session agent before /goal ${action}; no Goal state was changed.`)
}

export async function executeOpenCode2DirectGoalCommand(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
): Promise<{ action: string; goal: GoalState | null }> {
  if (!directLifecyclePreviewRequested()) {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview is disabled. Set ${OPENCODE2_DIRECT_LIFECYCLE_ENV}=1 to enable it explicitly.`)
  }
  assertDirectLifecycleHost(ctx)
  if (!input?.sessionID) throw new Error("OpenCode Goals V2 direct command requires a sessionID")

  const parsed = parseGoalCommand(input.prompt?.text ?? "")
  if (!DIRECT_LIFECYCLE_ACTIONS.has(parsed.action)) {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview does not yet support /goal ${parsed.action}. No Goal state was changed.`)
  }
  requireDirectLifecycleCapabilities(ctx, parsed.action)

  const snapshot = await resolveSessionSnapshot(ctx, input.sessionID)
  const store = new GoalStore(snapshot.directory, { onTransition: createGoalTransitionNotifier(snapshot.directory) })
  let goal = await store.load(input.sessionID)

  if (parsed.action === "status") {
    await emitDirectGoalNotice(ctx, input, formatStatus(goal))
    return { action: parsed.action, goal }
  }
  if (parsed.action === "contract") {
    await emitDirectGoalNotice(ctx, input, formatContract(goal))
    return { action: parsed.action, goal }
  }

  if (parsed.action === "pause") {
    if (goal) {
      await interruptDirectGoalTurn(ctx, input.sessionID)
      goal = pauseGoal(goal)
      await store.save(goal)
    }
    await emitDirectGoalNotice(ctx, input, formatStatus(goal))
    return { action: parsed.action, goal }
  }

  if (parsed.action === "clear") {
    if (goal) await interruptDirectGoalTurn(ctx, input.sessionID)
    await store.clear(input.sessionID)
    await emitDirectGoalNotice(ctx, input, "Goal cleared.")
    return { action: parsed.action, goal: null }
  }

  const agent = requireExecutionAgent(parsed.action, snapshot.agent)

  if (parsed.action === "resume") {
    if (!goal) {
      await emitDirectGoalNotice(ctx, input, "No goal exists.")
      return { action: parsed.action, goal: null }
    }
    if (goal.status === "budget_limited" && budgetLimitHits(goal.usage, goal.budget).length) {
      await emitDirectGoalNotice(
        ctx,
        input,
        `${formatStatus(goal)}\nBudget is still exhausted. Increase or clear the reached limit before resuming.`,
      )
      return { action: parsed.action, goal }
    }

    goal = withExecutionAgent(resumeGoal(goal), agent)
    if (isRestrictedGoalAgent(agent)) {
      goal = pauseGoal(goal, restrictedAgentStopReason(agent))
      await store.save(goal)
      await emitDirectGoalNotice(ctx, input, planBoundaryMessage(goal, agent))
      return { action: parsed.action, goal }
    }

    await store.save(goal)
    await dispatchContinuationOrPause(ctx, input, store, goal)
    return { action: parsed.action, goal }
  }

  if (!parsed.objective) {
    throw new Error('Usage: /goal <objective> [--accept "criterion"] [--check "command"]')
  }

  if (parsed.action === "create") {
    if (goal && goal.status !== "completed") {
      throw new Error("An unfinished goal already exists. Use /goal edit, /goal clear, or complete it first.")
    }
    goal = createGoal({
      sessionID: input.sessionID,
      objective: parsed.objective,
      acceptance: parsed.acceptance,
      constraints: parsed.constraints,
      checks: parsed.checks,
      files: parsed.files,
      ...(parsed.notifyCommand ? { notifyCommand: parsed.notifyCommand } : {}),
      execution: { agent },
      budget: directBudgetPatch(parsed),
    })
    if (isRestrictedGoalAgent(agent)) {
      goal = pauseGoal(goal, restrictedAgentStopReason(agent))
      await store.save(goal)
      await emitDirectGoalNotice(ctx, input, planBoundaryMessage(goal, agent))
      return { action: parsed.action, goal }
    }
    await store.save(goal)
    await dispatchContinuationOrPause(ctx, input, store, goal)
    return { action: parsed.action, goal }
  }

  if (!goal) throw new Error("No goal exists to edit")
  await interruptDirectGoalTurn(ctx, input.sessionID)
  goal = editGoal(goal, {
    objective: parsed.objective,
    ...(parsed.acceptance.length ? { acceptance: parsed.acceptance } : {}),
    ...(parsed.constraints.length ? { constraints: parsed.constraints } : {}),
    ...(parsed.checks.length ? { checks: parsed.checks } : {}),
    ...(parsed.files.length ? { files: parsed.files } : {}),
    ...(parsed.notifyCommand ? { notifyCommand: parsed.notifyCommand } : {}),
    execution: {
      ...(goal.execution ?? {}),
      agent,
    },
  })
  const budgetPatch = directBudgetPatch(parsed)
  if (Object.keys(budgetPatch).length) goal = applyGoalBudget(goal, budgetPatch)
  if (isRestrictedGoalAgent(agent)) {
    goal = pauseGoal(goal, restrictedAgentStopReason(agent))
    await store.save(goal)
    await emitDirectGoalNotice(ctx, input, planBoundaryMessage(goal, agent))
    return { action: parsed.action, goal }
  }
  await store.save(goal)
  await dispatchContinuationOrPause(ctx, input, store, goal)
  return { action: parsed.action, goal }
}

/**
 * Read-only compatibility entrypoint retained for model-visible experimental consumers.
 * Exact OpenCode 2.0.11 now proves direct command origin and request-time tool
 * materialization, but model-visible lifecycle mutation still fails closed.
 * The separately gated direct slash-command callback is the only preview
 * authority allowed to write Goal state.
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

function addExperimentalCommand(commands: any, name: string, definition: any): void {
  const add = commands?.add
  if (typeof add !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle preview requires a command draft with add().")
  }
  if (add.length === 1) {
    add.call(commands, { ...definition, name })
    return
  }
  add.call(commands, name, definition)
}

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
    // OpenCode 2.0.11 now exposes a real host-native command callback and
    // materializes plugin tools into the effective provider request. Keep
    // model-visible lifecycle mutation read-only while the direct command path
    // is promoted separately behind an explicit preview flag.
    if (directLifecyclePreviewRequested()) {
      assertDirectLifecycleHost(ctx)
      if (typeof ctx.command?.transform !== "function") {
        throw new Error("OpenCode Goals V2 direct lifecycle preview requires command.transform().")
      }
      const inFlight = new Map<string, Promise<void>>()
      const runSerialized = async (input: OpenCode2DirectCommandInvocation) => {
        const key = firstString(input?.sessionID) ?? "__missing_session__"
        const previous = inFlight.get(key) ?? Promise.resolve()
        const current = previous
          .catch(() => undefined)
          .then(async () => {
            await executeOpenCode2DirectGoalCommand(ctx, input)
          })
        inFlight.set(key, current)
        try {
          await current
        } finally {
          if (inFlight.get(key) === current) inFlight.delete(key)
        }
      }
      await ctx.command.transform((commands) => {
        addExperimentalCommand(commands, "goal", {
          description: "Persistent OpenCode Goal lifecycle preview through the host-native direct command boundary.",
          execute: runSerialized,
        })
      })
    }

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

    // Current hosts invoke `context`; earlier prototypes used `request`.
    // Both are best-effort presentation hooks only. Neither authorizes
    // lifecycle mutation: the direct command callback is the authority boundary.
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
