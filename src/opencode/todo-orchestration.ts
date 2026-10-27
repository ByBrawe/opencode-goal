import type CorePlugin from "./plugin.js"
import { GoalStore, mutateGoal } from "../persistence/store.js"
import { parseGoalCommand } from "./command.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

export function installGoalTodoOrchestration(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const commandHook = hooks["command.execute.before"]
  if (typeof commandHook !== "function") return

  async function clearTodoBinding(sessionID: string, goalID: string, revision: number) {
    await mutateGoal(store, sessionID, (goal) => {
      if (goal.id !== goalID || goal.revision !== revision || !goal.todoPlan) return null
      const { todoPlan: _todoPlan, ...next } = goal
      return next
    }, { maxAttempts: 2 })
  }

  hooks["command.execute.before"] = async (event: any, output: any) => {
    let beforeID: string | undefined
    let action: ReturnType<typeof parseGoalCommand>["action"] | undefined
    if (event?.command === "goal") {
      const parsed = parseGoalCommand(event.arguments ?? "")
      action = parsed.action
      if (action === "restore") beforeID = (await store.load(event.sessionID))?.id
    }

    await commandHook(event, output)

    if (action !== "restore") return
    const restored = await store.load(event.sessionID)
    if (!restored || restored.id === beforeID || !restored.todoPlan) return
    await clearTodoBinding(event.sessionID, restored.id, restored.revision)
  }
}
