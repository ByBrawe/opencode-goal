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

  // Do not call the OpenCode client from here. The plugin can be loading inside
  // the very first directory-scoped host request; recursively calling
  // session.list/status from that bootstrap path can deadlock the instance.
  // The startup snapshot proves these goals predate this plugin instance, and
  // the delayed re-read below lets any concurrent pause/edit/clear win first.
  const timer = setTimeout(() => {
    void recoverStartupGoals(input, hooks, startupGoals)
  }, 750)
  timer.unref?.()
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
