import CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type SessionStatus = { type?: string }
type RecoveryClient = {
  session?: {
    list?: (...args: any[]) => Promise<unknown>
    status?: (...args: any[]) => Promise<unknown>
  }
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

export async function captureStartupGoals(directory: string): Promise<GoalState[]> {
  const store = new GoalStore(directory)
  return (await store.list()).filter((goal) => goal.status === "active")
}

export function scheduleStartupRecovery(input: PluginInput, hooks: PluginHooks, startupGoals: GoalState[]): void {
  if (!startupGoals.length || typeof hooks.event !== "function") return

  const originalConfig = hooks.config
  let scheduled = false
  hooks.config = async (config) => {
    await originalConfig?.(config)
    if (scheduled) return
    scheduled = true

    // OpenCode loads plugins while InstanceStore.boot() still owns an unfinished
    // per-directory Deferred. A second directory-scoped request waits on that
    // Deferred and is released only after the *entire* bootstrap graph (plugins,
    // LSP/share/format/VCS/snapshot/project init) finishes. Start exactly one
    // read-only list request in the background and never abort/retry it. This is
    // our host-ready barrier: unlike fixed timers or cancelled probes it cannot
    // fire recovery early or starve lazy instance initialization.
    void waitForBootstrapBarrier(input)
      .then((host) => host && recoverStartupGoals(input, hooks, startupGoals, host))
      .catch(() => undefined)
  }
}

async function waitForBootstrapBarrier(input: PluginInput): Promise<{
  sessions: Set<string>
  statuses: Record<string, SessionStatus>
} | null> {
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
  host: { sessions: Set<string>; statuses: Record<string, SessionStatus> },
): Promise<void> {
  const store = new GoalStore(input.directory)
  for (const startup of startupGoals) {
    if (!host.sessions.has(startup.sessionID)) continue
    const status = host.statuses[startup.sessionID]?.type
    if (status === "busy" || status === "retry") continue

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
