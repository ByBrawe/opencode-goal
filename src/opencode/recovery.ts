import type CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type SessionStatus = { type?: string }
type RecoveryClient = {
  session?: {
    list?: () => Promise<unknown>
    status?: () => Promise<unknown>
  }
}

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function readHostRecoveryState(client: RecoveryClient): Promise<{
  sessions: Set<string>
  statuses: Record<string, SessionStatus>
} | null> {
  if (typeof client.session?.list !== "function" || typeof client.session?.status !== "function") return null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [listed, statuses] = await Promise.all([
        client.session.list(),
        client.session.status(),
      ])
      const sessions = sessionIDs(listed)
      const status = statusMap(statuses)
      if (sessions && status) return { sessions, statuses: status }
    } catch {
      // A plugin can finish loading before the host's directory-scoped API is
      // fully ready. Recovery is best-effort and bounded; normal idle events
      // remain the primary continuation path after startup.
    }
    await sleep(150 * (attempt + 1))
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
  }, 250)
  timer.unref?.()
}

async function recoverStartupGoals(input: PluginInput, hooks: PluginHooks, startupGoals: GoalState[]): Promise<void> {
  const host = await readHostRecoveryState(input.client as unknown as RecoveryClient)
  if (!host) return

  const store = new GoalStore(input.directory)
  for (const startup of startupGoals) {
    if (!host.sessions.has(startup.sessionID)) continue

    const status = host.statuses[startup.sessionID]?.type
    if (status === "busy" || status === "retry") continue

    // Re-read immediately before dispatch so a user pause/edit/clear that won
    // the startup race always wins over recovery from the stale startup shard.
    const current = await store.load(startup.sessionID)
    if (!current || current.id !== startup.id || current.revision !== startup.revision || current.status !== "active") continue

    await hooks.event!({
      event: {
        type: "session.idle",
        properties: { sessionID: startup.sessionID },
      },
    })
  }
}
