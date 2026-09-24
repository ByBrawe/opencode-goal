import path from "node:path"
import { createGoal, editGoal, pauseGoal, resumeGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { applyGoalBudget, budgetLimitHits } from "../runtime/accounting.js"
import { formatGoalRuntimeFingerprint } from "../runtime/fingerprint.js"
import { parseGoalCommand } from "../opencode/command.js"
import { createGoalTransitionNotifier } from "../opencode/notify.js"
import { continuationPrompt } from "../opencode/prompt.js"

export const OPENCODE2_EXPERIMENTAL_PLUGIN_ID = "bybrawe.open-code-goals.v2-experimental"

const V2_CONTROL_TOOL = "opencode_goals_v2_control"
const V2_GET_TOOL = "opencode_goals_v2_get"
export const OPENCODE2_DIRECT_LIFECYCLE_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
const V2_READ_ONLY_NOTICE =
  "OpenCode Goals V2 model-visible lifecycle control remains read-only. Mutation is authorized only through the host-native direct command boundary when the explicit V2 lifecycle preview is enabled. No Goal state was changed."

type UnknownRecord = Record<string, unknown>

export interface OpenCode2ExperimentalContext {
  options?: Readonly<UnknownRecord>
  event?: {
    subscribe(input?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
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
  return firstString(
    item?.sessionID,
    nestedRecord(item, "data")?.sessionID,
    nestedRecord(item, "properties")?.sessionID,
    nestedRecord(item?.request, "session")?.id,
    record(item?.request)?.sessionID,
  )
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
    const hasStructuredParts = event.system.some((part: unknown) => {
      const item = record(part)
      return item?.type === "text" && typeof item?.text === "string"
    })
    const alreadyPresent = event.system.some((part: unknown) => {
      if (typeof part === "string") return part === text
      const item = record(part)
      return item?.type === "text" && item?.text === text
    })
    if (alreadyPresent) return

    // OpenCode 2.0.11 models session.context.system as SystemPart[].
    // Historical beta/synthetic adapters used string[]. Preserve an existing
    // string-array shape, but use the current structured shape for empty or
    // already-structured arrays so request validation succeeds on 2.0.11.
    if (hasStructuredParts || event.system.length === 0) {
      event.system.push({ type: "text", text })
    } else {
      event.system.push(text)
    }
    return
  }
  if (typeof event?.system === "string") {
    if (!event.system.includes(text)) event.system = event.system ? `${event.system}\n\n${text}` : text
    return
  }
  if (event && event.system === undefined) event.system = [{ type: "text", text }]
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


function directLifecyclePreviewEnabled(): boolean {
  const value = String(process.env[OPENCODE2_DIRECT_LIFECYCLE_ENV] ?? "").trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

const DIRECT_CAPABILITY_TTL_MS = 2 * 60_000
const DIRECT_MUTATION_ACTIONS = new Set(["create", "edit", "pause", "resume", "clear"])
const DIRECT_READ_ACTIONS = new Set(["status", "contract"])

export interface OpenCode2DirectCapability {
  sessionID: string
  messageID: string
  directory: string
  command: string
  canonicalCommand: string
  action: ReturnType<typeof parseGoalCommand>["action"]
  createdAt: number
  expiresAt: number
  state: "pending" | "armed"
  agent?: string
}

export interface OpenCode2DirectLifecycleRuntime {
  capabilities: Map<string, OpenCode2DirectCapability>
  armedBySession: Map<string, string>
}

export function createOpenCode2DirectLifecycleRuntime(): OpenCode2DirectLifecycleRuntime {
  return {
    capabilities: new Map(),
    armedBySession: new Map(),
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

function canonicalGoalCommand(parsed: ReturnType<typeof parseGoalCommand>): string {
  return JSON.stringify({
    action: parsed.action,
    objective: parsed.objective,
    acceptance: parsed.acceptance,
    constraints: parsed.constraints,
    checks: parsed.checks,
    files: parsed.files.map((item) => ({
      file: item.file,
      ...(item.contains === undefined ? {} : { contains: item.contains }),
    })),
    notifyCommand: parsed.notifyCommand ?? null,
    goalIDPrefix: parsed.goalIDPrefix ?? null,
    historyKeep: parsed.historyKeep ?? null,
    queuePosition: parsed.queuePosition ?? null,
    maxTurns: parsed.maxTurns ?? null,
    maxTokens: parsed.maxTokens ?? null,
    maxRuntimeMs: parsed.maxRuntimeMs ?? null,
    maxCost: parsed.maxCost ?? null,
  })
}

function normalizedGoalArguments(value: string): string {
  return value.trim().replace(/^\/goal(?:\s+|$)/i, "").trim()
}

function directCapabilityKey(sessionID: string, messageID: string): string {
  return `${sessionID}\u0000${messageID}`
}

function isReadOnlyAgent(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "plan"
}

function eventLastUserMessageID(event: any): string | undefined {
  const messages = Array.isArray(event?.messages) ? event.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index])
    if (String(message?.role ?? "").toLowerCase() !== "user") continue
    return firstString(message?.id, nestedRecord(message, "info")?.id)
  }
  return undefined
}

function deleteSessionCapabilities(runtime: OpenCode2DirectLifecycleRuntime, sessionID: string, exceptKey?: string): void {
  for (const [key, capability] of runtime.capabilities) {
    if (capability.sessionID === sessionID && key !== exceptKey) runtime.capabilities.delete(key)
  }
  const armed = runtime.armedBySession.get(sessionID)
  if (armed && armed !== exceptKey) runtime.armedBySession.delete(sessionID)
}

function lifecycleEventCreatedAt(event: unknown): number | undefined {
  const item = record(event)
  const value = item?.created ?? nestedRecord(item, "data")?.created ?? nestedRecord(item, "properties")?.created
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function revokeSessionCapabilitiesAtTerminal(
  runtime: OpenCode2DirectLifecycleRuntime,
  sessionID: string,
  boundaryAt: number | undefined,
): void {
  for (const [key, capability] of runtime.capabilities) {
    if (capability.sessionID !== sessionID) continue
    // V2 event delivery can lag behind command admission. An older execution's
    // terminal event must not revoke a capability created for a newer direct
    // command merely because both belong to the same session.
    if (boundaryAt !== undefined && capability.createdAt > boundaryAt) continue
    // Hosts without durable event timestamps cannot safely order an unarmed
    // capability against a late terminal event. Keep it hidden behind the
    // existing message-bound context match + short TTL rather than guessing.
    if (boundaryAt === undefined && capability.state === "pending") continue
    runtime.capabilities.delete(key)
    if (runtime.armedBySession.get(sessionID) === key) runtime.armedBySession.delete(sessionID)
  }
}

export function observeOpenCode2LifecycleBoundary(
  runtime: OpenCode2DirectLifecycleRuntime,
  event: unknown,
): "execution-terminal" | "session-deleted" | undefined {
  const item = record(event)
  const type = firstString(item?.type)
  const sessionID = sessionIDFromEvent(event)
  if (!type || !sessionID) return undefined

  if (
    type === "session.execution.succeeded"
    || type === "session.execution.failed"
    || type === "session.execution.interrupted"
  ) {
    // A direct-command mutation capability belongs to one execution only.
    // Once OpenCode 2 declares that execution terminal, retaining pending or
    // armed authority until its wall-clock TTL would allow a later request to
    // observe stale mutation authority.
    revokeSessionCapabilitiesAtTerminal(runtime, sessionID, lifecycleEventCreatedAt(event))
    return "execution-terminal"
  }

  if (type === "session.deleted") {
    deleteSessionCapabilities(runtime, sessionID)
    return "session-deleted"
  }

  return undefined
}

function revokeCapability(runtime: OpenCode2DirectLifecycleRuntime, capability: OpenCode2DirectCapability): void {
  const key = directCapabilityKey(capability.sessionID, capability.messageID)
  runtime.capabilities.delete(key)
  if (runtime.armedBySession.get(capability.sessionID) === key) {
    runtime.armedBySession.delete(capability.sessionID)
  }
}

function authorizationContext(capability: OpenCode2DirectCapability): string {
  return [
    "OpenCode Goal V2 host-authenticated lifecycle command.",
    `The host authenticated the current user message as a direct /goal command for action ${capability.action}.`,
    `Call ${V2_CONTROL_TOOL} exactly once with the exact authorized Goal arguments in its command field: ${JSON.stringify(capability.command)}.`,
    "Do not alter the lifecycle action or arguments. The tool is single-use, validates the host-bound message capability, and rejects mismatch or replay.",
  ].join("\n")
}

async function interruptBeforeDirectMutation(
  ctx: OpenCode2ExperimentalContext,
  sessionID: string,
  action: ReturnType<typeof parseGoalCommand>["action"],
): Promise<void> {
  if (!["edit", "pause", "clear"].includes(action)) return
  if (typeof ctx.session.interrupt !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview requires session.interrupt() before /goal ${action} can run.`)
  }
  await ctx.session.interrupt({ sessionID, resume: false })
}

async function promptDirectReadOnly(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
  text: string,
): Promise<void> {
  if (typeof ctx.session.prompt !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle preview requires session.prompt().")
  }
  await ctx.session.prompt({
    ...input.prompt,
    sessionID: input.sessionID,
    text,
    metadata: { opencode_goal_v2_direct_command: true, opencode_goal_v2_read_only: true },
    delivery: input.delivery ?? "steer",
    resume: true,
  })
}

function readOnlyCommandPrompt(kind: "status" | "contract", text: string): string {
  return [
    text,
    "",
    `This is the persisted OpenCode Goal ${kind}. Respond with this information only; do not perform work or mutate Goal lifecycle state.`,
  ].join("\n")
}

function requireDirectLifecycleCapabilities(
  ctx: OpenCode2ExperimentalContext,
  action: ReturnType<typeof parseGoalCommand>["action"],
): void {
  if ((DIRECT_MUTATION_ACTIONS.has(action) || DIRECT_READ_ACTIONS.has(action)) && typeof ctx.session.prompt !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview requires session.prompt() before /goal ${action} can run.`)
  }
  if (["edit", "pause", "clear"].includes(action) && typeof ctx.session.interrupt !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview requires session.interrupt() before /goal ${action} can run.`)
  }
}

async function loadDirectGoal(ctx: OpenCode2ExperimentalContext, sessionID: string, directory: string): Promise<GoalState | null> {
  const resolved = await resolveSessionDirectory(ctx, sessionID)
  if (resolved !== directory) {
    throw new Error("OpenCode Goals V2 direct lifecycle capability workspace changed before execution; no Goal state was changed.")
  }
  return await new GoalStore(directory).load(sessionID)
}

async function applyAuthorizedGoalMutation(
  ctx: OpenCode2ExperimentalContext,
  sessionID: string,
  directory: string,
  parsed: ReturnType<typeof parseGoalCommand>,
): Promise<GoalState | null> {
  const resolved = await resolveSessionDirectory(ctx, sessionID)
  if (resolved !== directory) {
    throw new Error("OpenCode Goals V2 direct lifecycle capability workspace changed before persistence; no Goal state was changed.")
  }

  const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })
  let goal = await store.load(sessionID)

  if (parsed.action === "pause") {
    if (goal) {
      goal = pauseGoal(goal)
      await store.save(goal)
    }
    return goal
  }

  if (parsed.action === "clear") {
    await store.clear(sessionID)
    return null
  }

  if (parsed.action === "resume") {
    if (!goal) throw new Error("No goal exists to resume. No Goal state was changed.")
    if (goal.status === "budget_limited" && budgetLimitHits(goal.usage, goal.budget).length) {
      throw new Error("Goal budget is still exhausted. Increase or clear the reached limit before resuming; no Goal state was changed.")
    }
    goal = resumeGoal(goal)
    await store.save(goal)
    return goal
  }

  if (!parsed.objective) {
    throw new Error('Usage: /goal <objective> [--accept "criterion"] [--check "command"]')
  }

  if (parsed.action === "create") {
    if (goal && goal.status !== "completed") {
      throw new Error("An unfinished goal already exists. Use /goal edit, /goal clear, or complete it first. No Goal state was changed.")
    }
    goal = createGoal({
      sessionID,
      objective: parsed.objective,
      acceptance: parsed.acceptance,
      constraints: parsed.constraints,
      checks: parsed.checks,
      files: parsed.files,
      ...(parsed.notifyCommand ? { notifyCommand: parsed.notifyCommand } : {}),
      budget: directBudgetPatch(parsed),
    })
    await store.save(goal)
    return goal
  }

  if (parsed.action !== "edit") {
    throw new Error(`OpenCode Goals V2 direct lifecycle capability cannot mutate /goal ${parsed.action}. No Goal state was changed.`)
  }
  if (!goal) throw new Error("No goal exists to edit. No Goal state was changed.")

  goal = editGoal(goal, {
    objective: parsed.objective,
    ...(parsed.acceptance.length ? { acceptance: parsed.acceptance } : {}),
    ...(parsed.constraints.length ? { constraints: parsed.constraints } : {}),
    ...(parsed.checks.length ? { checks: parsed.checks } : {}),
    ...(parsed.files.length ? { files: parsed.files } : {}),
    ...(parsed.notifyCommand ? { notifyCommand: parsed.notifyCommand } : {}),
  })
  const budgetPatch = directBudgetPatch(parsed)
  if (Object.keys(budgetPatch).length) goal = applyGoalBudget(goal, budgetPatch)
  await store.save(goal)
  return goal
}

async function executeAuthorizedGoalControl(
  ctx: OpenCode2ExperimentalContext,
  runtime: OpenCode2DirectLifecycleRuntime,
  input: { command?: unknown },
  toolContext: OpenCode2ExperimentalToolContext,
): Promise<ReturnType<typeof toolResponse>> {
  const sessionID = firstString(toolContext?.sessionID)
  if (!sessionID) throw new Error("OpenCode Goals V2 authorized control requires a sessionID")

  const key = runtime.armedBySession.get(sessionID)
  const capability = key ? runtime.capabilities.get(key) : undefined
  if (!key || !capability) {
    throw new Error("OpenCode Goals V2 lifecycle capability is not armed for this request. No Goal state was changed.")
  }

  // A tool invocation is the one allowed attempt. Revoke before validating any
  // model-controlled arguments so mismatch, errors, and persistence failures
  // cannot be retried or replayed without a fresh direct command.
  runtime.armedBySession.delete(sessionID)
  runtime.capabilities.delete(key)

  if (capability.state !== "armed" || capability.expiresAt < Date.now()) {
    throw new Error("OpenCode Goals V2 lifecycle capability expired or was not armed. No Goal state was changed.")
  }
  if (isReadOnlyAgent(toolContext.agent) || (capability.agent && firstString(toolContext.agent)?.toLowerCase() !== capability.agent.toLowerCase())) {
    throw new Error("OpenCode Goals V2 lifecycle capability agent mismatch; Plan/read-only execution cannot mutate Goal state.")
  }

  const raw = normalizedGoalArguments(String(input?.command ?? ""))
  const parsed = parseGoalCommand(raw)
  if (canonicalGoalCommand(parsed) !== capability.canonicalCommand) {
    throw new Error("OpenCode Goals V2 lifecycle capability arguments do not match the authenticated direct command. No Goal state was changed.")
  }

  const goal = await applyAuthorizedGoalMutation(ctx, sessionID, capability.directory, parsed)
  const message = goal
    ? `Authorized /goal ${parsed.action} applied. Persisted Goal status: ${goal.status}. The single-use capability is consumed.`
    : `Authorized /goal ${parsed.action} applied. No active Goal remains. The single-use capability is consumed.`
  return toolResponse(message, goal)
}

export async function executeOpenCode2DirectGoalCommand(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
  runtime: OpenCode2DirectLifecycleRuntime,
): Promise<{ action: string; goal: GoalState | null; messageID?: string; dispatched: boolean }> {
  if (!directLifecyclePreviewEnabled()) {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview is disabled. Set ${OPENCODE2_DIRECT_LIFECYCLE_ENV}=1 to enable it explicitly.`)
  }
  if (!input?.sessionID) throw new Error("OpenCode Goals V2 direct command requires a sessionID")

  const raw = normalizedGoalArguments(input.prompt?.text ?? "")
  const parsed = parseGoalCommand(raw)
  if (!DIRECT_MUTATION_ACTIONS.has(parsed.action) && !DIRECT_READ_ACTIONS.has(parsed.action)) {
    throw new Error(`OpenCode Goals V2 direct lifecycle preview does not yet support /goal ${parsed.action}. No Goal state was changed.`)
  }
  requireDirectLifecycleCapabilities(ctx, parsed.action)

  const directory = await resolveSessionDirectory(ctx, input.sessionID)
  const goal = await loadDirectGoal(ctx, input.sessionID, directory)

  if (parsed.action === "status") {
    await promptDirectReadOnly(ctx, input, readOnlyCommandPrompt("status", formatStatus(goal)))
    return { action: parsed.action, goal, dispatched: false }
  }
  if (parsed.action === "contract") {
    await promptDirectReadOnly(ctx, input, readOnlyCommandPrompt("contract", formatContract(goal)))
    return { action: parsed.action, goal, dispatched: false }
  }

  if ((parsed.action === "create" || parsed.action === "edit") && !parsed.objective) {
    throw new Error('Usage: /goal <objective> [--accept "criterion"] [--check "command"]')
  }
  if (parsed.action === "create" && goal && goal.status !== "completed") {
    throw new Error("An unfinished goal already exists. Use /goal edit, /goal clear, or complete it first. No Goal state was changed.")
  }
  if (parsed.action === "edit" && !goal) {
    throw new Error("No goal exists to edit. No Goal state was changed.")
  }
  if (parsed.action === "resume" && !goal) {
    await promptDirectReadOnly(ctx, input, "No goal exists. Respond only with that fact; do not perform work.")
    return { action: parsed.action, goal: null, dispatched: false }
  }
  if (parsed.action === "resume" && goal?.status === "budget_limited" && budgetLimitHits(goal.usage, goal.budget).length) {
    await promptDirectReadOnly(
      ctx,
      input,
      readOnlyCommandPrompt("status", `${formatStatus(goal)}\nBudget is still exhausted. Increase or clear the reached limit before resuming.`),
    )
    return { action: parsed.action, goal, dispatched: false }
  }

  await interruptBeforeDirectMutation(ctx, input.sessionID, parsed.action)

  if (typeof ctx.session.prompt !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle preview requires session.prompt().")
  }

  const promptInput = {
    ...input.prompt,
    sessionID: input.sessionID,
    text: raw,
    ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
  }
  const admitted = await ctx.session.prompt({ ...promptInput, resume: false })
  const messageID = firstString(record(admitted)?.id, nestedRecord(admitted, "data")?.id)
  if (!messageID) {
    throw new Error("OpenCode Goals V2 direct lifecycle preview did not receive a host user-message ID; no Goal state was changed.")
  }

  const capability: OpenCode2DirectCapability = {
    sessionID: input.sessionID,
    messageID,
    directory,
    command: raw,
    canonicalCommand: canonicalGoalCommand(parsed),
    action: parsed.action,
    createdAt: Date.now(),
    expiresAt: Date.now() + DIRECT_CAPABILITY_TTL_MS,
    state: "pending",
  }
  const key = directCapabilityKey(input.sessionID, messageID)
  deleteSessionCapabilities(runtime, input.sessionID)
  runtime.capabilities.set(key, capability)

  try {
    const resumed = await ctx.session.prompt({ ...promptInput, id: messageID, resume: true })
    const resumedMessageID = firstString(record(resumed)?.id, nestedRecord(resumed, "data")?.id)
    if (resumedMessageID && resumedMessageID !== messageID) {
      revokeCapability(runtime, capability)
      throw new Error("OpenCode Goals V2 direct lifecycle preview resumed with a different host user-message ID; no Goal state was changed.")
    }
  } catch (error) {
    revokeCapability(runtime, capability)
    throw error
  }

  return { action: parsed.action, goal, messageID, dispatched: true }
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


const authorizedControlInputSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Exact Goal command arguments authorized by the host-native direct /goal command.",
    },
  },
  required: ["command"],
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
    add.call(tools, {
      ...definition,
      name,
      options: definition?.options ?? { codemode: false },
      // Older beta adapters read this legacy top-level hint while current
      // OpenCode 2 Tool.Info reads options.codemode.
      codemode: false,
    })
    return
  }
  add.call(tools, name, definition, { codemode: false })
}

export const OpenCode2GoalsExperimental = {
  id: OPENCODE2_EXPERIMENTAL_PLUGIN_ID,
  setup: async (ctx: OpenCode2ExperimentalContext) => {
    const runtime = createOpenCode2DirectLifecycleRuntime()
    const previewEnabled = directLifecyclePreviewEnabled()
    const lifecycleAbort = new AbortController()
    let lifecycleTask: Promise<void> | undefined

    if (typeof ctx.event?.subscribe === "function") {
      lifecycleTask = (async () => {
        try {
          const events = ctx.event!.subscribe({ signal: lifecycleAbort.signal })
          for await (const event of events) observeOpenCode2LifecycleBoundary(runtime, event)
        } catch (error) {
          // The V2 adapter is still an explicit preview. Raw-event loss must
          // never manufacture lifecycle mutation; existing TTL/context guards
          // remain fail-closed while stable recovery parity is unfinished.
          if (!lifecycleAbort.signal.aborted) return
        }
      })()
      void lifecycleTask.catch(() => undefined)
    }

    if (previewEnabled) {
      if (typeof ctx.command?.transform !== "function") {
        throw new Error("OpenCode Goals V2 direct lifecycle preview requires command.transform().")
      }
      await ctx.command.transform((commands) => {
        addExperimentalCommand(commands, "goal", {
          description: "Persistent OpenCode Goal lifecycle preview through a host-authenticated single-use capability.",
          execute: async (input: OpenCode2DirectCommandInvocation) => {
            await executeOpenCode2DirectGoalCommand(ctx, input, runtime)
          },
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

      if (previewEnabled) {
        addExperimentalTool(tools, V2_CONTROL_TOOL, {
          description: "Consume the one-use host-authenticated direct /goal lifecycle capability for the current request. This tool is removed from ordinary, replayed, and Plan/read-only requests.",
          input: authorizedControlInputSchema,
          output: controlOutputSchema,
          execute: async (input: { command?: unknown }, toolContext: OpenCode2ExperimentalToolContext) =>
            await executeAuthorizedGoalControl(ctx, runtime, input, toolContext),
        })
      }
    })

    const injectPersistedContext = async (event: any, allowAuthorization: boolean) => {
      const sessionID = sessionIDFromEvent(event)
      if (!sessionID) {
        removeControlTool(event)
        return
      }

      if (!previewEnabled || !allowAuthorization) {
        removeControlTool(event)
      } else {
        const lastUserMessageID = eventLastUserMessageID(event)

        // OpenCode can emit auxiliary context passes before the admitted user
        // message is present. Hide the mutating tool on those passes, but keep
        // the pending capability until a concrete user-message ID can either
        // match it or invalidate it. This mirrors the exact 2.0.11 capability
        // canary and prevents auxiliary/title work from consuming authority.
        if (!lastUserMessageID) {
          removeControlTool(event)
        } else {
          const key = directCapabilityKey(sessionID, lastUserMessageID)
          const capability = runtime.capabilities.get(key)

          if (!capability) {
            deleteSessionCapabilities(runtime, sessionID)
            removeControlTool(event)
          } else if (capability.expiresAt < Date.now() || isReadOnlyAgent(event?.agent)) {
            revokeCapability(runtime, capability)
            deleteSessionCapabilities(runtime, sessionID)
            removeControlTool(event)
          } else if (!event?.tools || typeof event.tools !== "object" || !event.tools[V2_CONTROL_TOOL]) {
            revokeCapability(runtime, capability)
            removeControlTool(event)
          } else {
            deleteSessionCapabilities(runtime, sessionID, key)
            capability.state = "armed"
            const agent = firstString(event?.agent)
            if (agent) capability.agent = agent
            else delete capability.agent
            runtime.armedBySession.set(sessionID, key)
            appendSystemContext(event, authorizationContext(capability))
          }
        }
      }

      let directory: string
      try {
        directory = await resolveSessionDirectory(ctx, sessionID)
      } catch {
        deleteSessionCapabilities(runtime, sessionID)
        removeControlTool(event)
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

    try {
      await ctx.session.hook("context", async (event: any) => {
        await injectPersistedContext(event, true)
      })
    } catch {
      // Exact OpenCode 2.0.11 exposes context. If it is absent, preview
      // capability authorization fails closed because no request can arm it.
    }

    try {
      await ctx.session.hook("request", async (event: any) => {
        await injectPersistedContext(event, false)
      })
    } catch {
      // Historical prototypes used request. It remains presentation-only and
      // can never arm a lifecycle capability.
    }

    try {
      await ctx.session.hook("compaction", async (event: any) => {
        // Compaction may run without the ordinary request/context hook. Carry
        // the persisted Goal contract into that host-owned request, but never
        // expose mutation authority from a direct lifecycle command.
        await injectPersistedContext(event, false)
      })
    } catch {
      // Older beta hosts may not expose compaction. Stable V2 compaction parity
      // is not claimed unless the exact-host evidence gate proves this hook.
    }

    return async () => {
      lifecycleAbort.abort()
      runtime.capabilities.clear()
      runtime.armedBySession.clear()
      await lifecycleTask?.catch(() => undefined)
    }
  },
}

export default OpenCode2GoalsExperimental
