import CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type SessionStatus = { type?: string }
type RecoveryClient = {
  session?: {
    list?: (options?: any) => Promise<unknown>
    status?: (options?: any) => Promise<unknown>
  }
}

type HostReadiness = {
  sessions: Set<string>
  statuses: Record<string, SessionStatus>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function dataOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  if ("data" in value) return (value as { data?: unknown }).data
  return value
}

function sessionIDs(value: unknown): Set<string> | null {
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

function statusMap(value: unknown): Record<string, SessionStatus> | null {
  const data = dataOf(value)
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  return data as Record<string, SessionStatus>
}

async function waitForHostReadiness(input: PluginInput): Promise<HostReadiness | null> {
  const client = input.client as unknown as RecoveryClient
  if (typeof client.session?.list !== "function") return null

  // A plugin is loaded inside OpenCode's lazy directory-instance bootstrap.
  // Re-entering that same instance synchronously can deadlock on slower hosts.
  // Probe with a short abortable request; while bootstrap owns the instance
  // lock the probe times out harmlessly, then succeeds once normal requests can
  // be serviced. Never send the mutating recovery prompt until that boundary.
  const deadline = Date.now() + 65_000
  await sleep(1_500)

  while (Date.now() < deadline) {
    try {
      const listed = await client.session.list({
        query: { directory: input.directory },
        signal: AbortSignal.timeout(1_000),
      })
      const sessions = sessionIDs(listed)
      if (!sessions) throw new Error("session list was not ready")

      let statuses: Record<string, SessionStatus> = {}
      if (typeof client.session.status === "function") {
        const rawStatus = await client.session.status({
          query: { directory: input.directory },
          signal: AbortSignal.timeout(1_000),
        })
        const parsed = statusMap(rawStatus)
        if (!parsed) throw new Error("session status was not ready")
        statuses = parsed
      }
      return { sessions, statuses }
    } catch {
      await sleep(500)
    }
  }
  return null
}

export async function captureStartupGoals(directory: string): Promise<GoalState[]> {
  const store = new GoalStore(directory)
  return (await store.list()).filter((goal) => goal.status === "active")
}

export function scheduleStartupRecovery(input: PluginInput, hooks: PluginHooks, startupGoals: GoalState[]): void {
  if (!startupGoals.length || typeof hooks.event !== "function") return

  const timer = setTimeout(() => {
    void recoverStartupGoals(input, hooks, startupGoals)
  }, 0)
  timer.unref?.()
}

async function recoverStartupGoals(input: PluginInput, hooks: PluginHooks, startupGoals: GoalState[]): Promise<void> {
  const host = await waitForHostReadiness(input)
  if (!host) return

  const store = new GoalStore(input.directory)
  for (const startup of startupGoals) {
    if (!host.sessions.has(startup.sessionID)) continue
    const hostStatus = host.statuses[startup.sessionID]?.type
    if (hostStatus === "busy" || hostStatus === "retry") continue

    // Re-read immediately before dispatch so a user pause/edit/clear that won
    // the startup race always wins over recovery from the stale startup shard.
    const current = await store.load(startup.sessionID)
    if (!current || current.id !== startup.id || current.revision !== startup.revision || current.status !== "active") continue

    // Reuse the normal idle continuation path so existing dispatch locking,
    // budget checks, no-progress accounting, and execution-context restoration
    // remain the single source of truth after a process restart.
    await hooks.event!({
      event: {
        type: "session.idle",
        properties: { sessionID: startup.sessionID },
      },
    })
  }
}
