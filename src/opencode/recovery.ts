import CorePlugin from "./plugin.js"
import { pauseGoal } from "../domain/goal.js"
import type { GoalExecutionContext, GoalState } from "../domain/types.js"
import { scanRecoverableGoalStates } from "../persistence/diagnostics.js"
import { GoalStore } from "../persistence/store.js"
import { isRestrictedGoalAgent, restrictedAgentStopReason } from "./agent-boundary.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type SessionStatus = { type?: string }
type RecoveryClient = {
  session?: {
    list?: (...args: any[]) => Promise<unknown>
    status?: (...args: any[]) => Promise<unknown>
    prompt?: (input: any) => Promise<unknown>
  }
}

type RecoveryGate = {
  sessions: Set<string>
  statuses: Record<string, SessionStatus>
}

type RecoveryRuntime = {
  pending: Set<string>
  inFlight: Set<string>
  deferredIdle: Set<string>
  originalEvent: PluginHooks["event"]
}

function dataOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  if ("data" in value) return (value as { data?: unknown }).data
  return value
}

function listedSessionIDs(value: unknown): Set<string> | null {
  const data = dataOf(value)
  if (!Array.isArray(data)) return null
  const ids = new Set<string>()
  for (const item of data) {
    if (!item || typeof item !== "object") continue
    const id = (item as { id?: unknown }).id
    if (typeof id === "string" && id) ids.add(id)
  }
  return ids
}

function sessionStatuses(value: unknown): Record<string, SessionStatus> | null {
  const data = dataOf(value)
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  return data as Record<string, SessionStatus>
}

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function textFromParts(parts: any[]): string {
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

function waitingForInfrastructureRecovery(goal: GoalState, now = Date.now()): boolean {
  return goal.status === "active"
    && Boolean(goal.infrastructureRecovery?.nextRetryAt)
    && Number(goal.infrastructureRecovery?.nextRetryAt) > now
}

async function sdkRecoveryPrompt(
  input: PluginInput,
  sessionID: string,
  text: string,
  execution?: GoalExecutionContext,
): Promise<void> {
  const client = input.client as unknown as RecoveryClient
  if (typeof client.session?.prompt !== "function") throw new Error("OpenCode session.prompt is unavailable")
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text }],
      ...(execution?.agent ? { agent: execution.agent } : {}),
      ...(execution?.model ? { model: execution.model } : {}),
      ...(execution?.variant ? { variant: execution.variant } : {}),
    },
  })
}

export async function captureStartupGoals(directory: string): Promise<GoalState[]> {
  const store = new GoalStore(directory)
  const active = (await scanRecoverableGoalStates(directory)).filter((goal) => goal.status === "active")
  const recoverable: GoalState[] = []
  for (const goal of active) {
    const agent = goal.execution?.agent
    if (isRestrictedGoalAgent(agent)) {
      await store.save(pauseGoal(goal, restrictedAgentStopReason(agent)))
      continue
    }
    // A persisted infrastructure cooldown has its own restart-safe timer and
    // single-owner wake-up. Generic startup recovery must not bypass that
    // deadline or race it with a second continuation prompt.
    if (waitingForInfrastructureRecovery(goal)) continue
    recoverable.push(goal)
  }
  return recoverable
}

export function scheduleStartupRecovery(input: PluginInput, hooks: PluginHooks, startupGoals: GoalState[]): void {
  if (!startupGoals.length || typeof hooks.event !== "function") return

  const originalEvent = hooks.event
  const runtime: RecoveryRuntime = {
    pending: new Set(startupGoals.map((goal) => goal.sessionID)),
    inFlight: new Set(),
    deferredIdle: new Set(),
    originalEvent,
  }

  // An idle emitted while the host is restoring a pre-existing active goal is
  // not proof that the interrupted assistant turn completed. Suppress it until
  // restart recovery has either been dispatched or safely abandoned. If idle
  // arrives while the recovery prompt itself is in flight, defer exactly one
  // copy and replay it after that real turn settles.
  hooks.event = async (eventInput: any) => {
    const sessionID = eventSessionID(eventInput)
    if (eventInput?.event?.type === "session.idle" && sessionID && runtime.pending.has(sessionID)) {
      if (runtime.inFlight.has(sessionID)) runtime.deferredIdle.add(sessionID)
      return
    }
    await originalEvent(eventInput)
  }

  const originalConfig = hooks.config
  let scheduled = false
  hooks.config = async (config) => {
    await originalConfig?.(config)
    if (scheduled) return
    scheduled = true

    // OpenCode loads plugins while InstanceStore.boot() still owns an unfinished
    // per-directory Deferred. A second directory-scoped request waits on that
    // Deferred and is released only after the entire bootstrap graph finishes.
    // Use one read-only request as a host-ready barrier and never abort/retry it
    // from product code; the real-host canary owns its own bounded HTTP retry.
    void waitForBootstrapBarrier(input)
      .then(async (host) => {
        if (!host) {
          runtime.pending.clear()
          return
        }
        await recoverStartupGoals(input, hooks, startupGoals, host, runtime)
      })
      .catch(() => {
        runtime.pending.clear()
      })
  }
}

async function waitForBootstrapBarrier(input: PluginInput): Promise<RecoveryGate | null> {
  const client = input.client as unknown as RecoveryClient
  if (typeof client.session?.list !== "function") return null

  const listed = await client.session.list()
  const sessions = listedSessionIDs(listed)
  if (!sessions) return null

  let statuses: Record<string, SessionStatus> = {}
  if (typeof client.session.status === "function") {
    const raw = await client.session.status()
    const parsed = sessionStatuses(raw)
    if (!parsed) return null
    statuses = parsed
  }
  return { sessions, statuses }
}

async function recoverStartupGoals(
  input: PluginInput,
  hooks: PluginHooks,
  startupGoals: GoalState[],
  host: RecoveryGate,
  runtime: RecoveryRuntime,
): Promise<void> {
  const store = new GoalStore(input.directory)
  const commandHook = hooks["command.execute.before"]

  for (const startup of startupGoals) {
    const sessionID = startup.sessionID
    if (!runtime.pending.has(sessionID)) continue

    if (!host.sessions.has(sessionID)) {
      runtime.pending.delete(sessionID)
      continue
    }
    const status = host.statuses[sessionID]?.type
    if (status === "busy" || status === "retry") {
      runtime.pending.delete(sessionID)
      continue
    }

    const current = await store.load(sessionID)
    if (!current || current.id !== startup.id || current.revision !== startup.revision || current.status !== "active") {
      runtime.pending.delete(sessionID)
      continue
    }
    // The infrastructure coordinator may have entered cooldown after the startup
    // snapshot was captured but before the bootstrap barrier released.
    if (waitingForInfrastructureRecovery(current)) {
      runtime.pending.delete(sessionID)
      continue
    }
    const currentAgent = current.execution?.agent
    if (isRestrictedGoalAgent(currentAgent)) {
      await store.save(pauseGoal(current, restrictedAgentStopReason(currentAgent)))
      runtime.pending.delete(sessionID)
      continue
    }

    let promptStarted = false
    let promptFailed = false
    try {
      if (typeof commandHook !== "function") throw new Error("OpenCode goal command hook is unavailable")

      // Reuse the core command hook only to seed TurnOwnership with the exact
      // continuation text. resumeGoal() would normally reset stalled/observed
      // accounting, so restore the unchanged persisted snapshot before any host
      // prompt is sent. No interrupted turn is closed or counted here.
      const output: any = { parts: [{ type: "text", text: "" }] }
      await commandHook({ command: "goal", sessionID, arguments: "resume" }, output)
      const prepared = await store.load(sessionID)
      if (!prepared || prepared.id !== current.id || prepared.revision !== current.revision || prepared.status !== "active") {
        runtime.pending.delete(sessionID)
        continue
      }
      current.storageGeneration = prepared.storageGeneration ?? 0
      await store.save(current)

      const text = textFromParts(output.parts)
      if (!text) throw new Error("restart recovery produced an empty continuation prompt")

      runtime.inFlight.add(sessionID)
      promptStarted = true
      await sdkRecoveryPrompt(input, sessionID, text, current.execution)
    } catch (error) {
      promptFailed = true
      const latest = await store.load(sessionID)
      if (latest?.id === current.id && latest.revision === current.revision && latest.status === "active") {
        await store.save(pauseGoal(latest, `Restart recovery prompt failed: ${String(error)}`))
      }
    } finally {
      runtime.inFlight.delete(sessionID)
      runtime.pending.delete(sessionID)
      const replayIdle = runtime.deferredIdle.delete(sessionID)
      if (promptStarted && !promptFailed && replayIdle) {
        await runtime.originalEvent({
          event: { type: "session.idle", properties: { sessionID } },
        })
      }
    }
  }
}
