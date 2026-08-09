import type CorePlugin from "./plugin.js"
import { GoalStore } from "../persistence/store.js"
import { showGoalToast } from "./toast.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

const TASK_TOOL = "task"

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function add(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key) ?? new Set<string>()
  set.add(value)
  map.set(key, set)
}

function remove(map: Map<string, Set<string>>, key: string, value: string): boolean {
  const set = map.get(key)
  if (!set) return false
  const removed = set.delete(value)
  if (!set.size) map.delete(key)
  return removed
}

function count(map: Map<string, Set<string>>, key: string): number {
  return map.get(key)?.size ?? 0
}

function taskIDFromOutput(output: any): string | undefined {
  const metadata = output?.metadata
  if (typeof metadata?.sessionId === "string" && metadata.sessionId) return metadata.sessionId
  const text = typeof output?.output === "string" ? output.output : ""
  const match = text.match(/<task\s+id="([^"]+)"\s+state="(?:running|completed|error)">/i)
  return match?.[1]
}

function isBackgroundTask(event: any, output: any): boolean {
  return event?.args?.background === true || output?.metadata?.background === true
}

export function syntheticTaskResult(parts: any[]): { taskID: string; state: "completed" | "error" } | null {
  for (const part of parts ?? []) {
    if (part?.type !== "text" || part?.synthetic !== true || typeof part.text !== "string") continue
    const match = part.text.match(/<task\s+id="([^"]+)"\s+state="(completed|error)">/i)
    if (match) return { taskID: match[1]!, state: match[2]!.toLowerCase() as "completed" | "error" }
  }
  return null
}

/**
 * Defer autonomous parent continuation while OpenCode is still executing a
 * delegated `task` subagent. This uses the task tool lifecycle and child-session
 * terminal events instead of polling `/session/status`, whose busy state may lag.
 */
export function installTaskDeferral(input: PluginInput, hooks: PluginHooks): void {
  const beforeHook = hooks["tool.execute.before"]
  const afterHook = hooks["tool.execute.after"]
  const chatHook = hooks["chat.message"]
  const eventHook = hooks.event
  if (typeof chatHook !== "function" || typeof eventHook !== "function") return

  const store = new GoalStore(input.directory)
  const foregroundCalls = new Map<string, Set<string>>()
  const backgroundChildren = new Map<string, Set<string>>()
  const childParent = new Map<string, string>()
  const notified = new Set<string>()

  function activeCount(parentID: string): number {
    return count(foregroundCalls, parentID) + count(backgroundChildren, parentID)
  }

  function clearChild(childID: string) {
    const parentID = childParent.get(childID)
    if (!parentID) return
    childParent.delete(childID)
    remove(backgroundChildren, parentID, childID)
    if (!activeCount(parentID)) notified.delete(parentID)
  }

  hooks["tool.execute.before"] = async (event: any) => {
    await beforeHook?.(event)
    if (event?.tool !== TASK_TOOL) return
    if (typeof event.sessionID !== "string" || typeof event.callID !== "string") return
    add(foregroundCalls, event.sessionID, event.callID)
  }

  hooks["tool.execute.after"] = async (event: any, output: any) => {
    await afterHook?.(event, output)
    if (event?.tool !== TASK_TOOL) return
    const parentID = typeof event.sessionID === "string" ? event.sessionID : undefined
    const callID = typeof event.callID === "string" ? event.callID : undefined
    if (!parentID) return
    if (callID) remove(foregroundCalls, parentID, callID)

    if (isBackgroundTask(event, output)) {
      const childID = taskIDFromOutput(output)
      if (childID) {
        add(backgroundChildren, parentID, childID)
        childParent.set(childID, parentID)
      }
    }
    if (!activeCount(parentID)) notified.delete(parentID)
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const taskResult = syntheticTaskResult(output?.parts ?? [])
    if (taskResult) {
      // OpenCode generated this host message when a background child finished.
      // It is not user intervention and must not pause the parent Goal.
      clearChild(taskResult.taskID)
      return
    }
    await chatHook(event, output)
  }

  hooks.event = async (eventInput: any) => {
    const type = String(eventInput?.event?.type ?? "")
    const sessionID = eventSessionID(eventInput)
    if (!sessionID) {
      await eventHook(eventInput)
      return
    }

    if (["session.idle", "session.error", "session.deleted"].includes(type) && childParent.has(sessionID)) {
      clearChild(sessionID)
      await eventHook(eventInput)
      return
    }

    if (type === "session.idle" && activeCount(sessionID) > 0) {
      const goal = await store.load(sessionID)
      if (goal?.status === "active") {
        if (!notified.has(sessionID)) {
          notified.add(sessionID)
          const total = activeCount(sessionID)
          await showGoalToast(input.client, `Goal waiting for ${total} delegated task${total === 1 ? "" : "s"}. Parent auto-continue deferred.`, "info")
        }
        return
      }
    }

    await eventHook(eventInput)
  }
}
