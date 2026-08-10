import type CorePlugin from "./plugin.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import { normalizeNativeTodos, observeTodoPlan } from "../runtime/todo-plan.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

interface TodoCallOwner {
  goalID: string
  revision: number
}

function callKey(sessionID: string, callID: string): string {
  return `${sessionID}\u0000${callID}`
}

function todosFromHook(event: any, output: any) {
  return normalizeNativeTodos(output?.metadata?.todos ?? event?.args?.todos)
}

export function installGoalTodoOrchestration(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const beforeHook = hooks["tool.execute.before"]
  const afterHook = hooks["tool.execute.after"]
  const calls = new Map<string, TodoCallOwner>()
  const callOrder: string[] = []

  function remember(key: string, owner: TodoCallOwner) {
    if (!calls.has(key)) callOrder.push(key)
    calls.set(key, owner)
    while (callOrder.length > 256) {
      const stale = callOrder.shift()
      if (stale) calls.delete(stale)
    }
  }

  hooks["tool.execute.before"] = async (event: any) => {
    if (typeof beforeHook === "function") await beforeHook(event)
    if (event?.tool !== "todowrite" || typeof event?.sessionID !== "string" || typeof event?.callID !== "string") return

    const goal = await store.load(event.sessionID)
    if (!goal || goal.status !== "active") return
    remember(callKey(event.sessionID, event.callID), { goalID: goal.id, revision: goal.revision })
  }

  hooks["tool.execute.after"] = async (event: any, output: any) => {
    if (typeof afterHook === "function") await afterHook(event, output)
    if (event?.tool !== "todowrite" || typeof event?.sessionID !== "string" || typeof event?.callID !== "string") return

    const key = callKey(event.sessionID, event.callID)
    const owner = calls.get(key)
    calls.delete(key)
    if (!owner) return

    const todos = todosFromHook(event, output)
    if (!todos) return

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const goal = await store.load(event.sessionID)
      if (!goal || goal.status !== "active" || goal.id !== owner.goalID || goal.revision !== owner.revision) return
      const next = observeTodoPlan(goal, todos)
      if (next === goal) return
      try {
        await store.save(next)
        return
      } catch (error) {
        if (error instanceof GoalStoreConcurrencyError && error.kind === "stale_write" && attempt === 0) continue
        throw error
      }
    }
  }
}
