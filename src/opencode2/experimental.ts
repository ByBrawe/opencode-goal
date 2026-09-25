import path from "node:path"
import { createGoal, editGoal, pauseGoal, resumeGoal } from "../domain/goal.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { applyGoalBudget, budgetLimitHits } from "../runtime/accounting.js"
import { formatGoalRuntimeFingerprint } from "../runtime/fingerprint.js"
import {
  clearInfrastructureRecovery,
  enterInfrastructureRecovery,
  isTransientInfrastructureError,
  markInfrastructureRecoveryDispatched,
} from "../runtime/infrastructure-recovery.js"
import { parseGoalCommand } from "../opencode/command.js"
import { createGoalTransitionNotifier, notifyGoal } from "../opencode/notify.js"
import { markHostProgress } from "../runtime/progress.js"
import { continuationPrompt } from "../opencode/prompt.js"
import { createOpenCode2CompactionBoundaryRuntime, observeOpenCode2CompactionBoundary, prepareOpenCode2PostCompactionContinuation, type OpenCode2CompactionBoundaryResult, type OpenCode2CompactionBoundaryRuntime } from "./compaction-boundary.js"
import { prepareOpenCode2Continuation } from "./continuation-boundary.js"
import { createOpenCode2AutonomousRuntime, armOpenCode2GoalExecution, clearOpenCode2GoalOwnership, consumeOpenCode2GoalExecution, consumeOpenCode2GoalKickoff, forgetOpenCode2GoalPrompt, rememberOpenCode2GoalKickoff, rememberOpenCode2GoalPrompt, type OpenCode2AutonomousRuntime, type OpenCode2GoalContinuationSource } from "./autonomous-runtime.js"
import { createOpenCode2SemanticVerifierRuntime, OPENCODE2_VERIFIER_RESULT_TOOL } from "./semantic-verifier.js"
import { createOpenCode2GoalWorkTools } from "./work-tools.js"
import {
  observeOpenCode2ModelRegistryLimits,
  type OpenCode2ModelRegistry,
} from "./model-context.js"
import {
  applyOpenCode2ControlPlaneMutation,
  OPENCODE2_EXTRA_MUTATION_ACTIONS,
  OPENCODE2_READ_CONTROL_ACTIONS,
  readOpenCode2ControlPlane,
} from "./control-plane.js"
import {
  applyOpenCode2GoalTelemetry,
  beginOpenCode2TelemetryExecution,
  clearOpenCode2TelemetrySession,
  createOpenCode2TelemetryRuntime,
  finishOpenCode2TelemetryExecution,
  observeOpenCode2TelemetryEvent,
  openCode2ToolTelemetry,
} from "./telemetry-runtime.js"
import {
  classifyOpenCode2ExecutionFailure,
  clearOpenCode2HostLimitSession,
  consumeOpenCode2CompactionReason,
  createOpenCode2HostLimitRuntime,
  markOpenCode2OwnedExecutionSuccess,
  observeOpenCode2CompactionReason,
  observeOpenCode2NativeCompaction,
  repeatedOpenCode2CompactionReason,
} from "./host-limits.js"
import {
  collectOpenCode2SuccessfulToolProgress,
  createOpenCode2ToolProgressRuntime,
  forgetOpenCode2ToolProgressCall,
  forgetOpenCode2ToolProgressSession,
  rememberOpenCode2ShellBefore,
} from "./tool-progress.js"

export const OPENCODE2_EXPERIMENTAL_PLUGIN_ID = "bybrawe.open-code-goals.v2-experimental"

const V2_CONTROL_TOOL = "opencode_goals_v2_control"
const V2_GET_TOOL = "opencode_goals_v2_get"
export const OPENCODE2_DIRECT_LIFECYCLE_ENV = "OPENCODE_GOAL_V2_DIRECT_LIFECYCLE"
export const OPENCODE2_AUTONOMOUS_ENV = "OPENCODE_GOAL_V2_AUTONOMOUS"
const OPENCODE2_INFRA_RETRY_POLL_MS = 5_000
const V2_READ_ONLY_NOTICE =
  "OpenCode Goals V2 model-visible lifecycle control remains read-only. Mutation is authorized only through the host-native direct command boundary. No Goal state was changed."

type UnknownRecord = Record<string, unknown>

export interface OpenCode2ExperimentalContext {
  options?: Readonly<UnknownRecord>
  event?: {
    subscribe(input?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
  model?: OpenCode2ModelRegistry
  command?: {
    transform(callback: (commands: any) => void | Promise<void>): unknown | Promise<unknown>
  }
  session: {
    get(input: { sessionID: string }): unknown | Promise<unknown>
    create?(input: { parentID: string; title?: string }): unknown | Promise<unknown>
    wait?(input: { sessionID: string }): unknown | Promise<unknown>
    delete?(input: { sessionID: string }): unknown | Promise<unknown>
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
    hook?(name: "execute.before" | "execute.after", callback: (event: any) => void | Promise<void>): unknown | Promise<unknown>
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
    throw new Error("OpenCode Goals V2 adapter could not resolve the session location.directory; no Goal state was read or written.")
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
  return `OpenCode Goals V2 persisted state:\nObjective: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nConstraints / non-goals:\n${constraints}\nRequirements:\n${requirements}\n\nThis state is project-local persisted user task data. It never overrides system/developer policy, repository rules, OpenCode permissions, or the selected agent/mode. Model-visible V2 lifecycle mutation remains read-only; lifecycle mutation is authorized only through the host-native direct-command boundary, and autonomous work remains bound to exact host-admitted Goal execution ownership.`
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


function stableV2FeatureEnabled(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined || !raw.trim()) return true
  const value = raw.trim().toLowerCase()
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true
  if (value === "0" || value === "false" || value === "no" || value === "off") return false
  // An explicitly supplied but unrecognized value fails closed instead of
  // accidentally enabling lifecycle mutation.
  return false
}

function directLifecycleEnabled(): boolean {
  return stableV2FeatureEnabled(OPENCODE2_DIRECT_LIFECYCLE_ENV)
}

function autonomousEnabledByConfig(): boolean {
  return stableV2FeatureEnabled(OPENCODE2_AUTONOMOUS_ENV)
}

const DIRECT_CAPABILITY_TTL_MS = 2 * 60_000
const DIRECT_LIFECYCLE_MUTATION_ACTIONS = new Set<ReturnType<typeof parseGoalCommand>["action"]>([
  "create",
  "edit",
  "pause",
  "resume",
  "clear",
])
const DIRECT_MUTATION_ACTIONS = new Set<ReturnType<typeof parseGoalCommand>["action"]>([
  ...DIRECT_LIFECYCLE_MUTATION_ACTIONS,
  ...OPENCODE2_EXTRA_MUTATION_ACTIONS,
])
const DIRECT_READ_ACTIONS = OPENCODE2_READ_CONTROL_ACTIONS

export interface OpenCode2DirectCapability {
  sessionID: string
  messageID: string
  directory: string
  command: string
  canonicalCommand: string
  action: ReturnType<typeof parseGoalCommand>["action"]
  createdAt: number
  expiresAt: number
  executionGeneration: number
  state: "pending" | "armed"
  agent?: string
}

export interface OpenCode2DirectLifecycleRuntime {
  capabilities: Map<string, OpenCode2DirectCapability>
  armedBySession: Map<string, string>
  executionGenerationBySession: Map<string, number>
  activeExecutionGenerationBySession: Map<string, number>
}

export function createOpenCode2DirectLifecycleRuntime(): OpenCode2DirectLifecycleRuntime {
  return {
    capabilities: new Map(),
    armedBySession: new Map(),
    executionGenerationBySession: new Map(),
    activeExecutionGenerationBySession: new Map(),
  }
}

function currentExecutionGeneration(runtime: OpenCode2DirectLifecycleRuntime, sessionID: string): number {
  return runtime.executionGenerationBySession.get(sessionID) ?? 0
}

function beginExecutionGeneration(runtime: OpenCode2DirectLifecycleRuntime, sessionID: string): number {
  const next = currentExecutionGeneration(runtime, sessionID) + 1
  runtime.executionGenerationBySession.set(sessionID, next)
  runtime.activeExecutionGenerationBySession.set(sessionID, next)
  return next
}

function activeOrNextExecutionGeneration(runtime: OpenCode2DirectLifecycleRuntime, sessionID: string): number {
  return runtime.activeExecutionGenerationBySession.get(sessionID)
    ?? currentExecutionGeneration(runtime, sessionID) + 1
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

function revokeSessionCapabilitiesAtTerminal(
  runtime: OpenCode2DirectLifecycleRuntime,
  sessionID: string,
  boundaryGeneration: number,
): void {
  for (const [key, capability] of runtime.capabilities) {
    if (capability.sessionID !== sessionID) continue
    // Direct command admission happens before its execution starts. Bind the
    // capability to the next observed execution generation so a delayed
    // terminal from the previous execution cannot revoke newer authority.
    if (capability.executionGeneration > boundaryGeneration) continue
    runtime.capabilities.delete(key)
    if (runtime.armedBySession.get(sessionID) === key) runtime.armedBySession.delete(sessionID)
  }
}

export function observeOpenCode2LifecycleBoundary(
  runtime: OpenCode2DirectLifecycleRuntime,
  event: unknown,
): "execution-started" | "execution-terminal" | "session-deleted" | undefined {
  const item = record(event)
  const type = firstString(item?.type)
  const sessionID = sessionIDFromEvent(event)
  if (!type || !sessionID) return undefined

  if (type === "session.execution.started") {
    beginExecutionGeneration(runtime, sessionID)
    return "execution-started"
  }

  if (
    type === "session.execution.succeeded"
    || type === "session.execution.failed"
    || type === "session.execution.interrupted"
  ) {
    const generation = runtime.activeExecutionGenerationBySession.get(sessionID)
      ?? currentExecutionGeneration(runtime, sessionID)
    revokeSessionCapabilitiesAtTerminal(runtime, sessionID, generation)
    runtime.activeExecutionGenerationBySession.delete(sessionID)
    return "execution-terminal"
  }

  if (type === "session.deleted") {
    deleteSessionCapabilities(runtime, sessionID)
    runtime.executionGenerationBySession.delete(sessionID)
    runtime.activeExecutionGenerationBySession.delete(sessionID)
    return "session-deleted"
  }

  return undefined
}

export interface OpenCode2AuthorityBoundaryObservation {
  kind?: "compaction-execution" | "execution-started" | "execution-terminal" | "session-deleted"
  sessionID?: string
  generation?: number
  compaction: OpenCode2CompactionBoundaryResult
}

export function inspectOpenCode2AuthorityBoundary(
  runtime: OpenCode2DirectLifecycleRuntime,
  compactionRuntime: OpenCode2CompactionBoundaryRuntime,
  event: unknown,
): OpenCode2AuthorityBoundaryObservation {
  const type = firstString(record(event)?.type)
  const sessionID = sessionIDFromEvent(event)
  const generationBefore = sessionID
    ? runtime.activeExecutionGenerationBySession.get(sessionID) ?? currentExecutionGeneration(runtime, sessionID)
    : undefined
  const compaction = observeOpenCode2CompactionBoundary(compactionRuntime, event)

  // A compaction execution still receives a normal execution.started event, so
  // let that event advance generation ownership. Only its terminal is consumed
  // by the compaction coordinator.
  if (compaction.consumedExecution) {
    if (sessionID) runtime.activeExecutionGenerationBySession.delete(sessionID)
    return {
      kind: "compaction-execution",
      ...(sessionID ? { sessionID } : {}),
      ...(generationBefore !== undefined ? { generation: generationBefore } : {}),
      compaction,
    }
  }

  const lifecycle = observeOpenCode2LifecycleBoundary(runtime, event)
  const generation = lifecycle === "execution-started" && sessionID
    ? runtime.activeExecutionGenerationBySession.get(sessionID)
    : lifecycle === "execution-terminal"
      ? generationBefore
      : undefined

  if (lifecycle === "session-deleted" && sessionID) {
    compactionRuntime.sessions.delete(sessionID)
  }

  return {
    ...(lifecycle ? { kind: lifecycle } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(generation !== undefined ? { generation } : {}),
    compaction,
  }
}

export function observeOpenCode2AuthorityBoundary(
  runtime: OpenCode2DirectLifecycleRuntime,
  compactionRuntime: OpenCode2CompactionBoundaryRuntime,
  event: unknown,
): "compaction-execution" | "execution-started" | "execution-terminal" | "session-deleted" | undefined {
  return inspectOpenCode2AuthorityBoundary(runtime, compactionRuntime, event).kind
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
    throw new Error(`OpenCode Goals V2 direct lifecycle requires session.interrupt() before /goal ${action} can run.`)
  }
  await ctx.session.interrupt({ sessionID, resume: false })
}

async function promptDirectReadOnly(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
  text: string,
): Promise<void> {
  if (typeof ctx.session.prompt !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle requires session.prompt().")
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
  if ((DIRECT_LIFECYCLE_MUTATION_ACTIONS.has(action) || DIRECT_READ_ACTIONS.has(action)) && typeof ctx.session.prompt !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle requires session.prompt() before /goal ${action} can run.`)
  }
  if (["edit", "pause", "clear"].includes(action) && typeof ctx.session.interrupt !== "function") {
    throw new Error(`OpenCode Goals V2 direct lifecycle requires session.interrupt() before /goal ${action} can run.`)
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
): Promise<{ goal: GoalState | null; message?: string; kickoff?: boolean }> {
  const resolved = await resolveSessionDirectory(ctx, sessionID)
  if (resolved !== directory) {
    throw new Error("OpenCode Goals V2 direct lifecycle capability workspace changed before persistence; no Goal state was changed.")
  }

  const controlPlane = await applyOpenCode2ControlPlaneMutation(directory, sessionID, parsed)
  if (controlPlane) return controlPlane

  const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })
  let goal = await store.load(sessionID)

  if (parsed.action === "pause") {
    if (goal) {
      goal = pauseGoal(goal)
      await store.save(goal)
    }
    return { goal }
  }

  if (parsed.action === "clear") {
    await store.clear(sessionID)
    return { goal: null }
  }

  if (parsed.action === "resume") {
    if (!goal) throw new Error("No goal exists to resume. No Goal state was changed.")
    if (goal.status === "budget_limited" && budgetLimitHits(goal.usage, goal.budget).length) {
      throw new Error("Goal budget is still exhausted. Increase or clear the reached limit before resuming; no Goal state was changed.")
    }
    goal = resumeGoal(goal)
    await store.save(goal)
    return { goal }
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
    return { goal }
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
  return { goal }
}

async function executeAuthorizedGoalControl(
  ctx: OpenCode2ExperimentalContext,
  runtime: OpenCode2DirectLifecycleRuntime,
  autonomousRuntime: OpenCode2AutonomousRuntime | undefined,
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

  if (autonomousRuntime) clearOpenCode2GoalOwnership(autonomousRuntime, sessionID)
  const applied = await applyAuthorizedGoalMutation(ctx, sessionID, capability.directory, parsed)
  const goal = applied.goal
  const shouldKickoff = Boolean(
    goal?.status === "active"
    && (
      applied.kickoff
      || parsed.action === "create"
      || parsed.action === "edit"
      || parsed.action === "resume"
    )
  )
  if (autonomousRuntime && shouldKickoff && goal) {
    rememberOpenCode2GoalKickoff(
      autonomousRuntime,
      sessionID,
      capability.executionGeneration,
      goal,
    )
  }
  const message = applied.message
    ? `${applied.message}\nThe single-use host capability is consumed.`
    : goal
      ? `Authorized /goal ${parsed.action} applied. Persisted Goal status: ${goal.status}. The single-use capability is consumed.`
      : `Authorized /goal ${parsed.action} applied. No active Goal remains. The single-use capability is consumed.`
  return toolResponse(message, goal)
}

export async function executeOpenCode2DirectGoalCommand(
  ctx: OpenCode2ExperimentalContext,
  input: OpenCode2DirectCommandInvocation,
  runtime: OpenCode2DirectLifecycleRuntime,
  options: {
    onAdminMutation?: (
      sessionID: string,
      parsed: ReturnType<typeof parseGoalCommand>,
      result: Awaited<ReturnType<typeof applyOpenCode2ControlPlaneMutation>>,
    ) => Promise<void>
  } = {},
): Promise<{ action: string; goal: GoalState | null; messageID?: string; dispatched: boolean; message?: string }> {
  if (!directLifecycleEnabled()) {
    throw new Error(`OpenCode Goals V2 direct lifecycle is disabled by ${OPENCODE2_DIRECT_LIFECYCLE_ENV}. Remove the override or set it to 1 to enable the stable V2 lifecycle.`)
  }
  if (!input?.sessionID) throw new Error("OpenCode Goals V2 direct command requires a sessionID")

  const raw = normalizedGoalArguments(input.prompt?.text ?? "")
  const parsed = parseGoalCommand(raw)
  if (!DIRECT_MUTATION_ACTIONS.has(parsed.action) && !DIRECT_READ_ACTIONS.has(parsed.action)) {
    throw new Error(`OpenCode Goals V2 direct lifecycle does not support /goal ${parsed.action}. No Goal state was changed.`)
  }
  requireDirectLifecycleCapabilities(ctx, parsed.action)

  const directory = await resolveSessionDirectory(ctx, input.sessionID)
  const goal = await loadDirectGoal(ctx, input.sessionID, directory)

  const readOnly = await readOpenCode2ControlPlane(directory, input.sessionID, parsed)
  if (readOnly !== undefined) {
    await promptDirectReadOnly(ctx, input, readOnlyCommandPrompt(
      parsed.action === "contract" ? "contract" : "status",
      readOnly,
    ))
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

  if (OPENCODE2_EXTRA_MUTATION_ACTIONS.has(parsed.action)) {
    await interruptBeforeDirectMutation(ctx, input.sessionID, parsed.action)
    const applied = await applyOpenCode2ControlPlaneMutation(directory, input.sessionID, parsed)
    if (!applied) {
      throw new Error(`OpenCode Goals V2 direct admin command did not handle /goal ${parsed.action}. No Goal state was changed.`)
    }
    await options.onAdminMutation?.(input.sessionID, parsed, applied)
    if (typeof ctx.session.prompt === "function") {
      try {
        await promptDirectReadOnly(
          ctx,
          input,
          `${applied.message}\n\nThis Goal administration mutation was applied directly by the host-native /goal command. Respond with this result only; do not perform project work or mutate Goal state.`,
        )
      } catch {
        // The admin mutation is already durably committed. A presentation-only
        // follow-up must never convert a successful host mutation into a false
        // failure or retry the mutation.
      }
    }
    return {
      action: parsed.action,
      goal: applied.goal,
      dispatched: false,
      message: applied.message,
    }
  }

  await interruptBeforeDirectMutation(ctx, input.sessionID, parsed.action)

  if (typeof ctx.session.prompt !== "function") {
    throw new Error("OpenCode Goals V2 direct lifecycle requires session.prompt().")
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
    throw new Error("OpenCode Goals V2 direct lifecycle did not receive a host user-message ID; no Goal state was changed.")
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
    executionGeneration: currentExecutionGeneration(runtime, input.sessionID) + 1,
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
      throw new Error("OpenCode Goals V2 direct lifecycle resumed with a different host user-message ID; no Goal state was changed.")
    }
  } catch (error) {
    revokeCapability(runtime, capability)
    throw error
  }

  return { action: parsed.action, goal, messageID, dispatched: true }
}

/**
 * Read-only compatibility entrypoint retained for callers that do not enter
 * through the host-native direct /goal command boundary. Status/contract and
 * other read surfaces remain available, while lifecycle mutation fails closed
 * without host-authorized command identity.
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

  const shown = await readOpenCode2ControlPlane(directory, toolContext.sessionID, parsed)
  if (shown !== undefined) return toolResponse(shown, goal)
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
    throw new Error("OpenCode Goals V2 direct lifecycle requires a command draft with add().")
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
    throw new Error("OpenCode Goals V2 adapter requires a tool draft with add().")
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
    const compactionRuntime = createOpenCode2CompactionBoundaryRuntime()
    const autonomousRuntime = createOpenCode2AutonomousRuntime()
    const telemetryRuntime = createOpenCode2TelemetryRuntime()
    const toolProgressRuntime = createOpenCode2ToolProgressRuntime()
    const hostLimitRuntime = createOpenCode2HostLimitRuntime()
    const hostLimitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const autonomousDispatching = new Set<string>()
    const lifecycleEnabled = directLifecycleEnabled()
    const autonomousEnabled = lifecycleEnabled && autonomousEnabledByConfig()
    const semanticVerifier = createOpenCode2SemanticVerifierRuntime(
      ctx.session,
      async (sessionID) => await resolveSessionDirectory(ctx, sessionID),
    )
    const workTools = createOpenCode2GoalWorkTools({
      autonomousRuntime,
      resolveDirectory: async (sessionID) => await resolveSessionDirectory(ctx, sessionID),
      semanticVerifier,
    })
    const lifecycleAbort = new AbortController()
    let lifecycleTask: Promise<void> | undefined

    const coordinatorGoal = async (sessionID: string) => {
      const directory = await resolveSessionDirectory(ctx, sessionID)
      const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })
      const goal = await store.load(sessionID)
      return { directory, store, goal }
    }

    const applySuccessfulToolProgress = async (sessionID: string, callID: string) => {
      const owner = autonomousRuntime.executionOwnerBySession.get(sessionID)
      const tool = openCode2ToolTelemetry(telemetryRuntime, sessionID, callID)
      if (!owner || !tool?.name) return

      try {
        const { directory, store, goal } = await coordinatorGoal(sessionID)
        if (
          !goal
          || goal.status !== "active"
          || goal.id !== owner.goalID
          || goal.revision !== owner.revision
        ) return

        const fingerprints = await collectOpenCode2SuccessfulToolProgress(toolProgressRuntime, {
          sessionID,
          callID,
          tool: tool.name,
          args: tool.input,
          metadata: tool.metadata,
          directory,
          goalID: goal.id,
          revision: goal.revision,
        })
        if (!fingerprints.length) return

        let next = goal
        const before = next.progressRevision
        for (const item of fingerprints) {
          next = markHostProgress(next, {
            fingerprint: item.fingerprint,
            source: `tool:${tool.name}`,
            summary: item.summary,
          })
        }
        if (next.progressRevision === before) return
        await store.save(next)
        notifyGoal(directory, next, "progress")
      } catch {
        // Progress telemetry is advisory. Never kill the V2 event subscriber
        // or authorize fallback mutation when hashing/state races fail.
      }
    }

    const rememberShellProgressStart = async (sessionID: string, callID: string) => {
      const owner = autonomousRuntime.executionOwnerBySession.get(sessionID)
      const tool = openCode2ToolTelemetry(telemetryRuntime, sessionID, callID)
      if (!owner || !tool?.name || (tool.name !== "shell" && tool.name !== "bash")) return

      try {
        const { directory, goal } = await coordinatorGoal(sessionID)
        if (
          !goal
          || goal.status !== "active"
          || goal.id !== owner.goalID
          || goal.revision !== owner.revision
        ) return
        await rememberOpenCode2ShellBefore(toolProgressRuntime, {
          sessionID,
          callID,
          tool: tool.name,
          args: tool.input,
          directory,
          goalID: goal.id,
          revision: goal.revision,
        })
      } catch {
        // Missing/unreadable state cannot authorize progress.
      }
    }

    const pauseAutonomousDispatchFailure = async (
      sessionID: string,
      goalID: string,
      revision: number,
      error: unknown,
    ) => {
      try {
        const { store, goal } = await coordinatorGoal(sessionID)
        if (!goal || goal.id !== goalID || goal.revision !== revision || goal.status !== "active") return
        if (isTransientInfrastructureError(error)) {
          const recovering = enterInfrastructureRecovery(goal, {
            kind: "continuation_dispatch",
            reason: String(error),
          })
          await store.save(recovering)
          armHostLimitRetry(recovering)
          return
        }
        await store.save(pauseGoal(goal, `Continuation dispatch failed: ${String(error)}`))
      } catch {
        // Failure recovery is advisory to the original transport error. Never
        // mutate a different Goal/revision because recovery itself raced.
      }
    }

    const scheduleAutonomousContinuation = async (
      sessionID: string,
      expectedGoal: GoalState,
      prompt: string,
      source: OpenCode2GoalContinuationSource,
    ) => {
      if (!autonomousEnabled || autonomousDispatching.has(sessionID) || typeof ctx.session.prompt !== "function") return

      const { goal } = await coordinatorGoal(sessionID)
      if (
        !goal
        || goal.id !== expectedGoal.id
        || goal.revision !== expectedGoal.revision
        || goal.status !== "active"
        || isReadOnlyAgent(goal.execution?.agent)
        || budgetLimitHits(goal.usage, goal.budget).length > 0
        || Boolean(goal.infrastructureRecovery?.nextRetryAt && goal.infrastructureRecovery.nextRetryAt > Date.now())
      ) return

      autonomousDispatching.add(sessionID)
      let messageID = ""
      const promptInput = {
        sessionID,
        text: prompt,
        delivery: "steer" as const,
        metadata: {
          opencode_goal_v2_autonomous: true,
          opencode_goal_v2_source: source,
          opencode_goal_id: goal.id,
          opencode_goal_revision: goal.revision,
        },
      }

      try {
        const admitted = await ctx.session.prompt({ ...promptInput, resume: false })
        messageID = firstString(record(admitted)?.id, nestedRecord(admitted, "data")?.id) ?? ""
        if (!messageID) throw new Error("OpenCode 2 did not return a host user-message ID for Goal continuation admission")

        rememberOpenCode2GoalPrompt(autonomousRuntime, sessionID, messageID, goal, source)
        queueMicrotask(() => {
          void Promise.resolve(ctx.session.prompt!({ ...promptInput, id: messageID, resume: true }))
            .then((resumed) => {
              const resumedMessageID = firstString(record(resumed)?.id, nestedRecord(resumed, "data")?.id)
              if (resumedMessageID && resumedMessageID !== messageID) {
                throw new Error("OpenCode 2 resumed Goal continuation with a different host user-message ID")
              }
            })
            .catch(async (error) => {
              forgetOpenCode2GoalPrompt(autonomousRuntime, sessionID, messageID)
              await pauseAutonomousDispatchFailure(sessionID, goal.id, goal.revision, error)
            })
            .finally(() => autonomousDispatching.delete(sessionID))
        })
      } catch (error) {
        if (messageID) forgetOpenCode2GoalPrompt(autonomousRuntime, sessionID, messageID)
        autonomousDispatching.delete(sessionID)
        await pauseAutonomousDispatchFailure(sessionID, goal.id, goal.revision, error)
      }
    }

    const cancelHostLimitRetry = (sessionID: string) => {
      const timer = hostLimitRetryTimers.get(sessionID)
      if (timer) clearTimeout(timer)
      hostLimitRetryTimers.delete(sessionID)
    }

    async function wakeHostLimitRetry(sessionID: string): Promise<void> {
      cancelHostLimitRetry(sessionID)
      try {
        const { store, goal } = await coordinatorGoal(sessionID)
        if (!goal || goal.status !== "active" || !goal.infrastructureRecovery) return

        const now = Date.now()
        if (goal.infrastructureRecovery.nextRetryAt > now) {
          armHostLimitRetry(goal)
          return
        }

        if (
          runtime.activeExecutionGenerationBySession.has(sessionID)
          || autonomousDispatching.has(sessionID)
        ) {
          const timer = setTimeout(() => {
            void wakeHostLimitRetry(sessionID)
          }, OPENCODE2_INFRA_RETRY_POLL_MS)
          ;(timer as any).unref?.()
          hostLimitRetryTimers.set(sessionID, timer)
          return
        }

        const dispatched = markInfrastructureRecoveryDispatched(goal, now)
        await store.save(dispatched)
        await scheduleAutonomousContinuation(
          sessionID,
          dispatched,
          continuationPrompt(dispatched),
          "recovery",
        )
      } catch {
        // A failed wake must not manufacture authority. Persisted recovery
        // remains the source of truth and a later host/restart boundary can retry.
      }
    }

    const armHostLimitRetry = (goal: GoalState) => {
      cancelHostLimitRetry(goal.sessionID)
      const retryAt = goal.infrastructureRecovery?.nextRetryAt
      if (goal.status !== "active" || !retryAt || retryAt <= 0) return

      const timer = setTimeout(() => {
        void wakeHostLimitRetry(goal.sessionID)
      }, Math.max(0, retryAt - Date.now()))
      ;(timer as any).unref?.()
      hostLimitRetryTimers.set(goal.sessionID, timer)
    }

    const nativeToolHooks = typeof ctx.tool.hook === "function"
    if (nativeToolHooks) {
      await ctx.tool.hook!("execute.before", async (event: any) => {
        const sessionID = firstString(event?.sessionID)
        const callID = firstString(event?.callID, event?.id)
        const tool = firstString(event?.tool, event?.name)
        if (!sessionID || !callID || !tool) return

        // OpenCode 2 exposes a native tool-execution boundary. Feed it into the
        // same telemetry/progress core instead of depending on loosely-shaped
        // server events when this stronger hook is available.
        observeOpenCode2TelemetryEvent(telemetryRuntime, sessionID, {
          type: "session.tool.called",
          data: {
            id: callID,
            name: tool,
            input: event?.input,
          },
        })
        await rememberShellProgressStart(sessionID, callID)
      })

      await ctx.tool.hook!("execute.after", async (event: any) => {
        const sessionID = firstString(event?.sessionID)
        const callID = firstString(event?.callID, event?.id)
        const tool = firstString(event?.tool, event?.name)
        if (!sessionID || !callID) return

        const completed = event?.status === "completed" || event?.status === "success" || event?.status === undefined
        observeOpenCode2TelemetryEvent(telemetryRuntime, sessionID, {
          type: completed ? "session.tool.success" : "session.tool.failed",
          data: {
            id: callID,
            ...(tool ? { name: tool } : {}),
            ...(event?.input !== undefined ? { input: event.input } : {}),
            ...(event?.result?.metadata !== undefined ? { metadata: event.result.metadata } : {}),
            executed: completed,
          },
        })

        if (completed) await applySuccessfulToolProgress(sessionID, callID)
        else forgetOpenCode2ToolProgressCall(toolProgressRuntime, sessionID, callID)
      })
    }

    if (typeof ctx.event?.subscribe === "function") {
      lifecycleTask = (async () => {
        try {
          const events = ctx.event!.subscribe({ signal: lifecycleAbort.signal })
          for await (const event of events) {
            const boundary = inspectOpenCode2AuthorityBoundary(runtime, compactionRuntime, event)
            const sessionID = boundary.sessionID
            const type = firstString(record(event)?.type)
            const data = nestedRecord(event, "data")
            let completedTelemetry: ReturnType<typeof finishOpenCode2TelemetryExecution>
            if (sessionID) observeOpenCode2CompactionReason(hostLimitRuntime, sessionID, event)

            if (sessionID && boundary.kind === "execution-started" && boundary.generation !== undefined) {
              beginOpenCode2TelemetryExecution(
                telemetryRuntime,
                sessionID,
                boundary.generation,
                event,
              )
            } else if (sessionID) {
              observeOpenCode2TelemetryEvent(telemetryRuntime, sessionID, event)
            }

            if (!nativeToolHooks && sessionID && type === "session.tool.called") {
              const callID = firstString(data?.id, data?.callID)
              if (callID) await rememberShellProgressStart(sessionID, callID)
            }
            if (!nativeToolHooks && sessionID && type === "session.tool.success") {
              const callID = firstString(data?.id, data?.callID)
              if (callID) await applySuccessfulToolProgress(sessionID, callID)
            }
            if (!nativeToolHooks && sessionID && type === "session.tool.failed") {
              const callID = firstString(data?.id, data?.callID)
              if (callID) forgetOpenCode2ToolProgressCall(toolProgressRuntime, sessionID, callID)
            }

            if (
              sessionID
              && boundary.generation !== undefined
              && (boundary.kind === "execution-terminal" || boundary.kind === "compaction-execution")
            ) {
              completedTelemetry = finishOpenCode2TelemetryExecution(
                telemetryRuntime,
                sessionID,
                boundary.generation,
                event,
              )
              forgetOpenCode2ToolProgressSession(toolProgressRuntime, sessionID)
            }

            if (boundary.kind === "session-deleted" && sessionID) {
              clearOpenCode2GoalOwnership(autonomousRuntime, sessionID)
              clearOpenCode2TelemetrySession(telemetryRuntime, sessionID)
              forgetOpenCode2ToolProgressSession(toolProgressRuntime, sessionID)
              clearOpenCode2HostLimitSession(hostLimitRuntime, sessionID)
              cancelHostLimitRetry(sessionID)
              workTools.clearSession(sessionID)
              autonomousDispatching.delete(sessionID)
              continue
            }
            if (!autonomousEnabled || !sessionID) continue

            if (boundary.compaction.compactionFailed) {
              const compactionReason = consumeOpenCode2CompactionReason(hostLimitRuntime, sessionID)
              if (compactionReason === "auto") {
                try {
                  const { store, goal } = await coordinatorGoal(sessionID)
                  if (goal?.status === "active") {
                    const failure = classifyOpenCode2ExecutionFailure(goal, data?.error)
                    const next = failure.kind === "ignore"
                      ? pauseGoal(
                          goal,
                          "OpenCode automatic compaction failed before the active Goal could recover. Goal state is preserved. Run /compact, then /goal resume.",
                        )
                      : failure.goal
                    await store.save(next)
                    if (failure.kind === "transient") armHostLimitRetry(next)
                    else cancelHostLimitRetry(sessionID)
                    clearOpenCode2GoalOwnership(autonomousRuntime, sessionID)
                  }
                } catch {
                  // A failed compaction never authorizes fallback dispatch.
                }
              }
              continue
            }
            if (boundary.compaction.compactionCompleted) {
              const compactionReason = consumeOpenCode2CompactionReason(hostLimitRuntime, sessionID)
              try {
                const { store, goal } = await coordinatorGoal(sessionID)
                if (goal) {
                  if (compactionReason === "auto" && goal.status === "active") {
                    const attempt = observeOpenCode2NativeCompaction(hostLimitRuntime, goal)
                    if (attempt.repeatedWithoutOwnedSuccess) {
                      const paused = pauseGoal(goal, repeatedOpenCode2CompactionReason())
                      await store.save(paused)
                      cancelHostLimitRetry(sessionID)
                      clearOpenCode2GoalOwnership(autonomousRuntime, sessionID)
                      continue
                    }
                  }

                  const prepared = prepareOpenCode2PostCompactionContinuation(goal)
                  if (prepared.shouldContinue && prepared.prompt) {
                    await scheduleAutonomousContinuation(sessionID, goal, prepared.prompt, "compaction")
                  }
                }
              } catch {
                // Missing/unreadable state cannot authorize autonomous work.
              }
              continue
            }

            if (boundary.kind !== "execution-terminal" || boundary.generation === undefined) continue
            const generation = boundary.generation
            const succeeded = type === "session.execution.succeeded"

            if (!succeeded) {
              const kickoff = consumeOpenCode2GoalKickoff(autonomousRuntime, sessionID, generation)
              const owner = consumeOpenCode2GoalExecution(autonomousRuntime, sessionID, generation)
              if (type !== "session.execution.failed") continue

              const expected = kickoff ?? owner
              if (!expected) continue

              try {
                const { store, goal } = await coordinatorGoal(sessionID)
                if (
                  !goal
                  || goal.status !== "active"
                  || goal.id !== expected.goalID
                  || goal.revision !== expected.revision
                ) continue

                const failure = classifyOpenCode2ExecutionFailure(goal, data?.error)
                if (failure.kind === "ignore") continue
                await store.save(failure.goal)
                if (failure.kind === "transient") armHostLimitRetry(failure.goal)
                else cancelHostLimitRetry(sessionID)
              } catch {
                // Failure events without fresh matching Goal ownership cannot
                // mutate persisted state or manufacture a retry.
              }
              continue
            }

            try {
              const { directory, store, goal } = await coordinatorGoal(sessionID)
              if (!goal) continue

              const kickoff = consumeOpenCode2GoalKickoff(autonomousRuntime, sessionID, generation)
              if (kickoff) {
                if (
                  goal.id === kickoff.goalID
                  && goal.revision === kickoff.revision
                  && goal.status === "active"
                ) {
                  await scheduleAutonomousContinuation(
                    sessionID,
                    goal,
                    continuationPrompt(goal),
                    "kickoff",
                  )
                }
                continue
              }

              const owner = consumeOpenCode2GoalExecution(autonomousRuntime, sessionID, generation)
              if (
                !owner
                || owner.goalID !== goal.id
                || owner.revision !== goal.revision
              ) continue

              let observedGoal = goal
              if (completedTelemetry) {
                const accounted = applyOpenCode2GoalTelemetry(
                  observedGoal,
                  owner.messageID,
                  completedTelemetry,
                )
                observedGoal = accounted.goal
              }
              if (observedGoal.infrastructureRecovery) {
                observedGoal = clearInfrastructureRecovery(observedGoal)
              }
              if (observedGoal !== goal) await store.save(observedGoal)
              cancelHostLimitRetry(sessionID)
              markOpenCode2OwnedExecutionSuccess(hostLimitRuntime, sessionID)

              if (observedGoal.status === "completed") {
                const promoted = await applyOpenCode2ControlPlaneMutation(
                  directory,
                  sessionID,
                  parseGoalCommand("next"),
                )
                if (promoted?.kickoff && promoted.goal?.status === "active") {
                  await scheduleAutonomousContinuation(
                    sessionID,
                    promoted.goal,
                    continuationPrompt(promoted.goal),
                    "sequence",
                  )
                }
                continue
              }

              const prepared = prepareOpenCode2Continuation(observedGoal, event)
              if (!prepared.closed) continue
              await store.save(prepared.goal)
              if (prepared.shouldContinue && prepared.prompt) {
                await scheduleAutonomousContinuation(
                  sessionID,
                  prepared.goal,
                  prepared.prompt,
                  "execution",
                )
              }
            } catch {
              // Event delivery alone never authorizes fallback mutation or
              // dispatch when persisted Goal state cannot be verified.
            }
          }
        } catch {
          // Raw-event loss cannot authorize mutation. Existing message-bound
          // capability checks and TTLs remain fail-closed.
        }
      })()
      void lifecycleTask.catch(() => undefined)
    }

    if (lifecycleEnabled) {
      if (typeof ctx.command?.transform !== "function") {
        throw new Error("OpenCode Goals V2 direct lifecycle requires command.transform().")
      }
      await ctx.command.transform((commands) => {
        addExperimentalCommand(commands, "goal", {
          description: "Persistent OpenCode Goal lifecycle through a host-authenticated single-use capability.",
          execute: async (input: OpenCode2DirectCommandInvocation) =>
            await executeOpenCode2DirectGoalCommand(ctx, input, runtime, {
              onAdminMutation: async (sessionID, parsed, applied) => {
                if (!autonomousEnabled) return
                clearOpenCode2GoalOwnership(autonomousRuntime, sessionID)
                if (!applied?.kickoff || !applied.goal || applied.goal.status !== "active") return
                await scheduleAutonomousContinuation(
                  sessionID,
                  applied.goal,
                  continuationPrompt(applied.goal),
                  parsed.action === "next" ? "sequence" : "kickoff",
                )
              },
            }),
        })
      })
    }

    await ctx.tool.transform((tools) => {
      addExperimentalTool(tools, V2_GET_TOOL, {
        description: "Read the current persisted OpenCode Goal through the OpenCode 2 adapter.",
        input: { type: "object", properties: {}, additionalProperties: false },
        output: controlOutputSchema,
        execute: async (_input: unknown, toolContext: OpenCode2ExperimentalToolContext) => {
          const directory = await resolveSessionDirectory(ctx, toolContext.sessionID)
          const goal = await new GoalStore(directory).load(toolContext.sessionID)
          return toolResponse(formatStatus(goal), goal)
        },
      })

      if (lifecycleEnabled) {
        addExperimentalTool(tools, V2_CONTROL_TOOL, {
          description: "Consume the one-use host-authenticated direct /goal lifecycle capability for the current request. This tool is removed from ordinary, replayed, and Plan/read-only requests.",
          input: authorizedControlInputSchema,
          output: controlOutputSchema,
          execute: async (input: { command?: unknown }, toolContext: OpenCode2ExperimentalToolContext) =>
            await executeAuthorizedGoalControl(ctx, runtime, autonomousEnabled ? autonomousRuntime : undefined, input, toolContext),
        })
      }

      if (autonomousEnabled) {
        addExperimentalTool(tools, OPENCODE2_VERIFIER_RESULT_TOOL, semanticVerifier.resultTool)
        for (const [name, definition] of Object.entries(workTools.definitions)) {
          addExperimentalTool(tools, name, definition)
        }
      }
    })

    const observeContextModelLimits = async (event: any) => {
      const sessionID = sessionIDFromEvent(event)
      if (!sessionID || !event?.model) return
      try {
        const directory = await resolveSessionDirectory(ctx, sessionID)
        const store = new GoalStore(directory, { onTransition: createGoalTransitionNotifier(directory) })
        const goal = await store.load(sessionID)
        if (!goal || goal.status === "completed") return
        const next = await observeOpenCode2ModelRegistryLimits(goal, ctx.model, event.model)
        if (next !== goal) await store.save(next)
      } catch {
        // Model-limit telemetry is advisory. Missing registry data or a
        // concurrent Goal mutation must never block the host context hook.
      }
    }

    const injectPersistedContext = async (event: any, allowAuthorization: boolean) => {
      const sessionID = sessionIDFromEvent(event)
      if (!sessionID) {
        removeControlTool(event)
        return
      }

      if (!lifecycleEnabled || !allowAuthorization) {
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
        if (semanticVerifier.handleContext(event)) return

        await observeContextModelLimits(event)

        if (autonomousEnabled) {
          const sessionID = sessionIDFromEvent(event)
          const lastUserMessageID = eventLastUserMessageID(event)
          if (sessionID && lastUserMessageID && !isReadOnlyAgent(event?.agent)) {
            const directKey = directCapabilityKey(sessionID, lastUserMessageID)
            const directCapability = runtime.capabilities.has(directKey)
            const armed = armOpenCode2GoalExecution(
              autonomousRuntime,
              sessionID,
              lastUserMessageID,
              activeOrNextExecutionGeneration(runtime, sessionID),
            )
            const existingOwner = autonomousRuntime.executionOwnerBySession.get(sessionID)
            const goalOwned = Boolean(armed || existingOwner?.messageID === lastUserMessageID)
            if (!goalOwned && !directCapability) {
              workTools.markForegroundSteering(sessionID, lastUserMessageID)
            }
          }
        }

        await injectPersistedContext(event, true)
        if (autonomousEnabled) workTools.handleContext(event)
      })
    } catch {
      // Exact OpenCode 2.0.11 exposes context. If it is absent, lifecycle
      // capability authorization fails closed because no request can arm it.
    }

    try {
      await ctx.session.hook("request", async (event: any) => {
        if (semanticVerifier.handleContext(event)) return
        await injectPersistedContext(event, false)
      })
    } catch {
      // Historical prototypes used request. It remains presentation-only and
      // can never arm a lifecycle capability.
    }

    try {
      await ctx.session.hook("compaction", async (event: any) => {
        // Compaction is host-owned and must never inherit direct lifecycle
        // mutation authority. Persisted Goal context is read-only here.
        if (semanticVerifier.handleContext(event)) return
        await injectPersistedContext(event, false)
        if (autonomousEnabled) workTools.hideFrom(event)
      })
    } catch {
      // Older beta hosts may not expose compaction. Stable V2 compaction parity
      // remains gated by the exact-host evidence path.
    }

    return async () => {
      lifecycleAbort.abort()
      runtime.capabilities.clear()
      runtime.armedBySession.clear()
      runtime.executionGenerationBySession.clear()
      runtime.activeExecutionGenerationBySession.clear()
      compactionRuntime.sessions.clear()
      autonomousRuntime.pendingPromptBySession.clear()
      autonomousRuntime.executionOwnerBySession.clear()
      autonomousRuntime.kickoffBySession.clear()
      telemetryRuntime.currentBySession.clear()
      toolProgressRuntime.shellPending.clear()
      for (const timer of hostLimitRetryTimers.values()) clearTimeout(timer)
      hostLimitRetryTimers.clear()
      hostLimitRuntime.successEpochBySession.clear()
      hostLimitRuntime.compactionReasonBySession.clear()
      hostLimitRuntime.compactionAttemptBySession.clear()
      autonomousDispatching.clear()
      await lifecycleTask?.catch(() => undefined)
    }
  },
}

export default OpenCode2GoalsExperimental
