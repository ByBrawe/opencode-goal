import type CorePlugin from "./plugin.js"
import type { GoalInfrastructureRecoveryKind, GoalState } from "../domain/types.js"
import { scanRecoverableGoalStates } from "../persistence/diagnostics.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import {
  clearInfrastructureRecovery,
  enterInfrastructureRecovery,
  isTransientInfrastructureError,
  legacyInfrastructureRecovery,
  markInfrastructureRecoveryDispatched,
} from "../runtime/infrastructure-recovery.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type TransientListener = (sessionID: string, error: unknown) => void

const INFRA_EVENT_MARKER = "__opencodeGoalInfrastructureRecovery"
const DEFAULT_RETRY_POLL_MS = 5_000
const DEFAULT_RETRY_WATCHDOG_MS = 2 * 60_000

function sessionIDFromPromptArgs(args: any[]): string | undefined {
  const first = args[0] ?? {}
  const value = first?.path?.id ?? first?.path?.sessionID ?? first?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function eventStatusType(input: any): string | undefined {
  const value = input?.event?.properties?.status?.type
  return typeof value === "string" ? value : undefined
}

function eventError(input: any): unknown {
  return input?.event?.properties?.error
}

function isInfrastructureWaiting(goal: GoalState): boolean {
  return goal.status === "active" && Boolean(goal.infrastructureRecovery?.nextRetryAt && goal.infrastructureRecovery.nextRetryAt > 0)
}

async function saveWithReload(store: GoalStore, goal: GoalState): Promise<GoalState> {
  try {
    await store.save(goal)
    return goal
  } catch (error) {
    if (!(error instanceof GoalStoreConcurrencyError)) throw error
    const latest = await store.load(goal.sessionID)
    if (!latest) throw error
    return latest
  }
}

/**
 * Observe transient failures from session.prompt without changing SDK behavior.
 * The stable core still sees the rejection and performs its normal cleanup;
 * the recovery coordinator then converts only known transient pauses back into
 * a persisted, backoff-controlled active recovery state.
 */
export function createGoalInfrastructureTransport(client: any) {
  const listeners = new Set<TransientListener>()
  const session = client?.session
  if (!session || typeof session !== "object") {
    return { client, subscribe(listener: TransientListener) { listeners.add(listener); return () => listeners.delete(listener) } }
  }

  const sessionProxy = new Proxy(session, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if ((property !== "prompt" && property !== "promptAsync") || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value
      }
      return async (...args: any[]) => {
        try {
          return await value.apply(target, args)
        } catch (error) {
          const sessionID = sessionIDFromPromptArgs(args)
          if (sessionID && isTransientInfrastructureError(error)) {
            for (const listener of listeners) listener(sessionID, error)
          }
          throw error
        }
      }
    },
  })

  const proxy = new Proxy(client, {
    get(target, property, receiver) {
      if (property === "session") return sessionProxy
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })

  return {
    client: proxy,
    subscribe(listener: TransientListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function installGoalInfrastructureRecovery(
  input: PluginInput,
  hooks: PluginHooks,
  transport?: ReturnType<typeof createGoalInfrastructureTransport>,
  options: { retryBaseMs?: number; retryMaxMs?: number; retryPollMs?: number; retryWatchdogMs?: number } = {},
): void {
  const store = new GoalStore(input.directory)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const retrySeenAt = new Map<string, number>()
  const retryBaseMs = options.retryBaseMs
  const retryMaxMs = options.retryMaxMs
  const retryPollMs = Math.max(10, Number(options.retryPollMs) || DEFAULT_RETRY_POLL_MS)
  const retryWatchdogMs = Math.max(retryPollMs, Number(options.retryWatchdogMs) || DEFAULT_RETRY_WATCHDOG_MS)

  function cancelTimer(sessionID: string) {
    const timer = timers.get(sessionID)
    if (timer) clearTimeout(timer)
    timers.delete(sessionID)
  }

  async function liveSessionStatus(sessionID: string): Promise<string | undefined> {
    const status = input.client?.session?.status
    if (typeof status !== "function") return undefined
    let attempted = false
    for (const args of [{ query: { directory: input.directory } }, {}]) {
      attempted = true
      try {
        const raw = await status.call(input.client.session, args)
        const data = raw && typeof raw === "object" && "data" in raw ? raw.data : raw
        if (!data || typeof data !== "object" || Array.isArray(data)) continue
        const entry = (data as Record<string, any>)[sessionID]
        const type = entry && typeof entry === "object" ? entry.type : undefined
        return typeof type === "string" ? type : "idle"
      } catch {
        // A status read can fail for the same transient outage. Preserve that as
        // unknown rather than turning uncertainty into permission to dispatch.
      }
    }
    return attempted ? "unknown" : undefined
  }

  async function abortRetryingGoalTurn(sessionID: string): Promise<void> {
    if (typeof input.client?.session?.abort !== "function") return
    try {
      await input.client.session.abort({ path: { id: sessionID } })
    } catch {
      // Recovery state remains authoritative even if the host already ended it.
    }
  }

  async function schedule(sessionID: string): Promise<void> {
    cancelTimer(sessionID)
    const goal = await store.load(sessionID)
    if (!goal || !isInfrastructureWaiting(goal)) return
    const delay = Math.max(0, goal.infrastructureRecovery!.nextRetryAt - Date.now())
    const timer = setTimeout(() => { void wake(sessionID) }, delay)
    timers.set(sessionID, timer)
  }

  async function postponeWhileHostRetries(sessionID: string, goal: GoalState): Promise<boolean> {
    const live = await liveSessionStatus(sessionID)
    if (live !== "retry" && live !== "unknown") {
      retrySeenAt.delete(sessionID)
      return false
    }

    const now = Date.now()
    const since = retrySeenAt.get(sessionID) ?? now
    retrySeenAt.set(sessionID, since)
    if (live === "retry" && now - since >= retryWatchdogMs) {
      // The host has owned this retry for too long. Abort once so older OpenCode
      // builds with unbounded retry loops can release the Goal back to the
      // plugin's persisted backoff state. Unknown status is never force-aborted.
      await abortRetryingGoalTurn(sessionID)
      retrySeenAt.delete(sessionID)
      const delayed: GoalState = {
        ...goal,
        infrastructureRecovery: goal.infrastructureRecovery
          ? { ...goal.infrastructureRecovery, nextRetryAt: now + retryPollMs }
          : undefined,
        updatedAt: now,
      }
      await saveWithReload(store, delayed)
      await schedule(sessionID)
      return true
    }

    cancelTimer(sessionID)
    timers.set(sessionID, setTimeout(() => { void wake(sessionID) }, retryPollMs))
    return true
  }

  async function wake(sessionID: string): Promise<void> {
    cancelTimer(sessionID)
    let goal = await store.load(sessionID)
    if (!goal || !isInfrastructureWaiting(goal)) return
    const now = Date.now()
    if (goal.infrastructureRecovery!.nextRetryAt > now) {
      await schedule(sessionID)
      return
    }
    if (await postponeWhileHostRetries(sessionID, goal)) return

    goal = markInfrastructureRecoveryDispatched(goal, now)
    await saveWithReload(store, goal)
    const hook = hooks.event
    if (typeof hook !== "function") return
    await hook({
      event: {
        type: "session.idle",
        properties: { sessionID, [INFRA_EVENT_MARKER]: true },
      },
    })
  }

  async function enter(
    sessionID: string,
    kind: GoalInfrastructureRecoveryKind,
    reason: string,
    allowStatuses: GoalState["status"][] = ["active", "paused", "blocked"],
  ): Promise<GoalState | undefined> {
    const latest = await store.load(sessionID)
    if (!latest || !allowStatuses.includes(latest.status) || latest.status === "completed") return undefined
    const next = enterInfrastructureRecovery(latest, {
      kind,
      reason,
      ...(retryBaseMs === undefined ? {} : { baseMs: retryBaseMs }),
      ...(retryMaxMs === undefined ? {} : { maxMs: retryMaxMs }),
    })
    const saved = await saveWithReload(store, next)
    if (saved.id === next.id && saved.revision === next.revision && saved.status === "active") await schedule(sessionID)
    return saved
  }

  async function inspectLegacyOrCorePause(sessionID: string): Promise<boolean> {
    const goal = await store.load(sessionID)
    if (!goal) return false
    const legacy = legacyInfrastructureRecovery(goal)
    if (!legacy) return false
    await enter(sessionID, legacy.kind, legacy.reason)
    return true
  }

  // The core completion tool intentionally paused on verifier infrastructure
  // failure in <=1.3.25. Keep the core verifier fail-closed, but convert only
  // that infrastructure pause into a backoff-controlled active recovery state.
  const completeTool: any = (hooks as any).tool?.opencode_goal_complete
  if (completeTool && typeof completeTool.execute === "function") {
    const originalComplete = completeTool.execute.bind(completeTool)
    completeTool.execute = async (args: any, context: any) => {
      const result = await originalComplete(args, context)
      if (typeof context?.sessionID !== "string") return result
      if (await inspectLegacyOrCorePause(context.sessionID)) {
        const goal = await store.load(context.sessionID)
        const retryAt = goal?.infrastructureRecovery?.nextRetryAt
        const seconds = retryAt ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) : 1
        return `Completion not verified because verifier/provider infrastructure is unavailable. Goal remains active and will retry automatically in about ${seconds}s; no manual /goal resume is required.`
      }
      return result
    }
  }

  // Observe transient prompt transport rejection. Let the core finish its
  // cleanup/pause first, then repair only a matching transient dispatch pause.
  transport?.subscribe((sessionID, error) => {
    setTimeout(() => {
      void (async () => {
        const goal = await store.load(sessionID)
        if (!goal) return
        if (goal.status === "paused" && String(goal.stopReason ?? "").startsWith("Continuation dispatch failed:")) {
          await enter(sessionID, "continuation_dispatch", String(goal.stopReason), ["paused"])
          return
        }
        // A retryable provider error can reject before a host session.error is
        // delivered. If the Goal is still active, put it behind the same gate.
        if (goal.status === "active" && isTransientInfrastructureError(error)) {
          await enter(sessionID, "continuation_dispatch", String(error), ["active"])
        }
      })().catch(() => undefined)
    }, 0)
  })

  const originalEvent = hooks.event
  if (typeof originalEvent === "function") {
    hooks.event = async (eventInput: any) => {
      const sessionID = eventSessionID(eventInput)
      const type = String(eventInput?.event?.type ?? "")
      const marked = eventInput?.event?.properties?.[INFRA_EVENT_MARKER] === true

      if (sessionID && type === "session.status") {
        const status = eventStatusType(eventInput)
        if (status === "retry") retrySeenAt.set(sessionID, retrySeenAt.get(sessionID) ?? Date.now())
        else if (status === "idle" || status === "busy") retrySeenAt.delete(sessionID)
      }

      if (sessionID && type === "session.error" && isTransientInfrastructureError(eventError(eventInput))) {
        await enter(sessionID, "provider_retry", JSON.stringify(eventError(eventInput)), ["active"])
      }

      // A host idle immediately after a verifier/provider failure is just the
      // failed turn settling; it must not bypass the persisted cooldown. Only
      // the coordinator's marked one-shot idle may wake a waiting recovery.
      if (sessionID && type === "session.idle" && !marked) {
        retrySeenAt.delete(sessionID)
        const goal = await store.load(sessionID)
        if (goal && isInfrastructureWaiting(goal)) {
          await schedule(sessionID)
          return
        }
      }

      if (sessionID && type === "session.idle") retrySeenAt.delete(sessionID)
      await originalEvent(eventInput)

      // A normal host idle can trigger a Goal-owned prompt whose promise rejects
      // asynchronously. Give the stable core a chance to persist its pause, then
      // repair it if and only if it is a recognized transient dispatch failure.
      if (sessionID && type === "session.idle" && !marked) {
        setTimeout(() => { void inspectLegacyOrCorePause(sessionID).catch(() => undefined) }, 0)
      }

      if (sessionID && type === "message.updated") {
        const info = eventInput?.event?.properties?.info
        if (info?.role === "assistant" && info?.time?.completed) {
          const goal = await store.load(sessionID)
          if (goal?.status === "active" && goal.infrastructureRecovery?.nextRetryAt === 0) {
            await saveWithReload(store, clearInfrastructureRecovery(goal))
          }
        }
      }

      if (sessionID && type === "session.deleted") {
        cancelTimer(sessionID)
        retrySeenAt.delete(sessionID)
      }
    }
  }

  // Migrate recoverable 1.3.25-era pause/block records and restore timers after
  // a process restart. This is deliberately narrow: genuine user pauses and
  // project blockers do not match legacyInfrastructureRecovery().
  const originalConfig = hooks.config
  let startupScheduled = false
  hooks.config = async (config: any) => {
    await originalConfig?.(config)
    if (startupScheduled) return
    startupScheduled = true
    queueMicrotask(() => {
      void (async () => {
        const states = await scanRecoverableGoalStates(input.directory)
        for (const state of states) {
          const legacy = legacyInfrastructureRecovery(state)
          if (legacy) {
            await enter(state.sessionID, legacy.kind, legacy.reason)
            continue
          }
          if (isInfrastructureWaiting(state)) await schedule(state.sessionID)
        }
      })().catch(() => undefined)
    })
  }
}
