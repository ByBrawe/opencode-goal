import CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

export async function captureStartupGoals(directory: string): Promise<GoalState[]> {
  const store = new GoalStore(directory)
  return (await store.list()).filter((goal) => goal.status === "active")
}

export function scheduleStartupRecovery(input: PluginInput, hooks: PluginHooks, startupGoals: GoalState[]): void {
  if (!startupGoals.length || typeof hooks.event !== "function") return

  // OpenCode invokes every plugin's config hook near the end of lazy instance
  // initialization, after plugin constructors have returned. Recovery must not
  // call back into the host while that constructor phase owns the directory
  // instance lock. Chain the existing config hook, then defer one macrotask so
  // OpenCode can finish installing the plugin event listener and publish the
  // initialized instance before any continuation prompt is sent.
  const originalConfig = hooks.config
  let scheduled = false
  hooks.config = async (config) => {
    await originalConfig?.(config)
    if (scheduled) return
    scheduled = true
    const timer = setTimeout(() => {
      void recoverStartupGoals(input, hooks, startupGoals)
    }, 0)
    timer.unref?.()
  }
}

async function recoverStartupGoals(input: PluginInput, hooks: PluginHooks, startupGoals: GoalState[]): Promise<void> {
  const store = new GoalStore(input.directory)
  for (const startup of startupGoals) {
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
