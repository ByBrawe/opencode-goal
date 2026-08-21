import type CorePlugin from "./plugin.js"
import { GoalStore } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type CompactionContinuationPhase = "pending" | "dispatching" | "awaiting_prompt"

type CompactionContinuationState = {
  token: number
  phase: CompactionContinuationPhase
}

const COMPACTION_CONTINUATION_MARKER = "__opencodeGoalCompactionContinuation"

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function markerToken(input: any): number | undefined {
  const value = input?.event?.properties?.[COMPACTION_CONTINUATION_MARKER]
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Give an active Goal sole ownership of post-compaction continuation.
 *
 * The core adapter already disables OpenCode's generic synthetic `continue`
 * while a Goal is active. Successful compaction therefore needs a guaranteed
 * Goal-owned wake-up even on hosts that do not emit a useful `session.idle`
 * afterwards. This coordinator turns the successful autocontinue hook into a
 * one-shot idle barrier and routes that idle back through the normal wrapper
 * stack so sequence/task/agent safety gates still win.
 *
 * State is intentionally in-memory. A process restart already has dedicated
 * active-Goal recovery; persisting another continuation marker would duplicate
 * that mechanism and add storage migration/corruption surface.
 */
export function installGoalCompactionContinuation(input: PluginInput, hooks: PluginHooks): void {
  const autocontinueHook = hooks["experimental.compaction.autocontinue"]
  const eventHook = hooks.event
  const chatHook = hooks["chat.message"]
  if (typeof autocontinueHook !== "function" || typeof eventHook !== "function" || typeof chatHook !== "function") return

  const store = new GoalStore(input.directory)
  const states = new Map<string, CompactionContinuationState>()
  let nextToken = 0

  function clear(sessionID: string) {
    states.delete(sessionID)
  }

  async function goalIsActive(sessionID: string): Promise<boolean> {
    const goal = await store.load(sessionID)
    return goal?.status === "active"
  }

  async function dispatchThroughInner(eventInput: any, sessionID: string, state: CompactionContinuationState): Promise<void> {
    const current = states.get(sessionID)
    if (current !== state || current.phase !== "pending") return
    current.phase = "dispatching"
    try {
      await eventHook(eventInput)
    } catch (error) {
      if (states.get(sessionID) === current) clear(sessionID)
      throw error
    }

    if (states.get(sessionID) !== current || current.phase !== "dispatching") return
    if (await goalIsActive(sessionID)) current.phase = "awaiting_prompt"
    else clear(sessionID)
  }

  function scheduleFallback(sessionID: string, token: number) {
    queueMicrotask(() => {
      const current = states.get(sessionID)
      if (!current || current.token !== token || current.phase !== "pending") return
      const hook = hooks.event
      if (typeof hook !== "function") {
        clear(sessionID)
        return
      }
      void hook({
        event: {
          type: "session.idle",
          properties: {
            sessionID,
            [COMPACTION_CONTINUATION_MARKER]: token,
          },
        },
      }).catch(() => {
        const latest = states.get(sessionID)
        if (latest?.token === token) clear(sessionID)
      })
    })
  }

  hooks["experimental.compaction.autocontinue"] = async (event: any, output: any) => {
    await autocontinueHook(event, output)
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined
    if (!sessionID) return

    // The stable core sets enabled=false only for an active Goal. Re-check the
    // persisted state because another wrapper/user action may have changed it
    // while compaction was finishing.
    if (output?.enabled !== false || !(await goalIsActive(sessionID))) {
      clear(sessionID)
      return
    }

    const token = ++nextToken
    states.set(sessionID, { token, phase: "pending" })
    scheduleFallback(sessionID, token)
  }

  hooks.event = async (eventInput: any) => {
    const type = String(eventInput?.event?.type ?? "")
    const sessionID = eventSessionID(eventInput)
    if (!sessionID || type !== "session.idle") {
      await eventHook(eventInput)
      return
    }

    const state = states.get(sessionID)
    const marker = markerToken(eventInput)
    if (marker !== undefined) {
      if (!state || state.token !== marker || state.phase !== "pending") return
      await dispatchThroughInner(eventInput, sessionID, state)
      return
    }

    if (!state) {
      await eventHook(eventInput)
      return
    }

    if (!(await goalIsActive(sessionID))) {
      clear(sessionID)
      await eventHook(eventInput)
      return
    }

    if (state.phase === "pending") {
      // A real host idle arrived before the queued fallback. It has already
      // passed every wrapper installed outside this coordinator, so let it be
      // the single owner instead of sending a second synthetic idle.
      await dispatchThroughInner(eventInput, sessionID, state)
      return
    }

    // Ignore duplicate/late compaction idles until OpenCode delivers the
    // programmatic continuation prompt through chat.message. The core adapter's
    // own dispatching/deferred-idle queue must not see this duplicate or it would
    // schedule an extra autonomous turn after the first continuation finishes.
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    if (typeof event?.sessionID === "string" && states.has(event.sessionID)) {
      // Any top-level chat message ends the compaction barrier. For the normal
      // path this is the Goal-owned programmatic continuation prompt. If a human
      // message wins the race instead, clearing here gives user steering
      // immediate priority and the core ownership logic handles preemption.
      clear(event.sessionID)
    }
    await chatHook(event, output)
  }
}
