import type CorePlugin from "./plugin.js"
import { GoalStore } from "../persistence/store.js"
import { fatalProviderReason, hostUsageLimitReason, markUsageLimited, pauseForFatalProviderError } from "../runtime/limits.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

async function abortSession(client: any, sessionID: string): Promise<void> {
  if (typeof client?.session?.abort !== "function") return
  try {
    await client.session.abort({ path: { id: sessionID } })
  } catch {
    // The provider error/retry may already have ended the run. State is still
    // authoritative and prevents the next idle from auto-continuing.
  }
}

export function installHostLimitHandling(input: PluginInput, hooks: PluginHooks): void {
  if (typeof hooks.event !== "function") return
  const originalEvent = hooks.event
  const store = new GoalStore(input.directory)

  hooks.event = async (eventInput: any) => {
    const type = String(eventInput?.event?.type ?? "")
    const properties = eventInput?.event?.properties ?? {}
    const sessionID = eventSessionID(eventInput)

    if (sessionID && type === "session.status") {
      const reason = hostUsageLimitReason(properties.status)
      if (reason) {
        const goal = await store.load(sessionID)
        if (goal?.status === "active") {
          await store.save(markUsageLimited(goal, reason))
          await abortSession(input.client, sessionID)
        }
        await originalEvent(eventInput)
        return
      }
    }

    if (sessionID && type === "session.error") {
      const reason = fatalProviderReason(properties.error)
      if (reason) {
        const goal = await store.load(sessionID)
        if (goal?.status === "active") {
          await store.save(pauseForFatalProviderError(goal, reason))
          await abortSession(input.client, sessionID)
        }
        await originalEvent(eventInput)
        return
      }
    }

    await originalEvent(eventInput)
  }
}
