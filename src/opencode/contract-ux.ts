import { replaceGoalConstraints } from "../domain/goal.js"
import { GoalStore } from "../persistence/store.js"
import { parseGoalCommand } from "./command.js"
import { continuationPrompt } from "./prompt.js"
import { showGoalToast } from "./toast.js"

type PromptTranslation = { shown: string; owned: string }

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

async function notifyCommand(client: any, store: GoalStore, sessionID: string, action: ReturnType<typeof parseGoalCommand>["action"]) {
  if (!["create", "edit", "pause", "resume", "clear"].includes(action)) return
  if (action === "clear") {
    await showGoalToast(client, "Goal cleared.", "info")
    return
  }
  const goal = await store.load(sessionID)
  if (!goal) return
  if (action === "create") await showGoalToast(client, `Goal active: ${goal.objective}`, "success")
  else if (action === "edit") await showGoalToast(client, `Goal contract updated (revision ${goal.revision}).`, "info")
  else if (action === "pause") await showGoalToast(client, "Goal paused.", "warning")
  else if (action === "resume") await showGoalToast(client, goal.status === "active" ? "Goal resumed." : `Goal remains ${goal.status}.`, goal.status === "active" ? "success" : "warning")
}

/**
 * Adds structured contract flags and best-effort TUI feedback without changing the
 * core command ownership protocol. The translation layer composes with controls.ts,
 * so budget/create/edit prompt ownership stays exact.
 */
export function installGoalContractUX(input: any, hooks: any): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const store = new GoalStore(input.directory)
  const translations = new Map<string, PromptTranslation>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    const parsed = parseGoalCommand(event.arguments ?? "")
    await commandHook(event, output)

    if ((parsed.action === "create" || parsed.action === "edit") && parsed.constraints.length) {
      const current = await store.load(event.sessionID)
      if (!current) throw new Error("Goal disappeared while applying Goal Contract constraints")
      const owned = textFromParts(output.parts)
      const next = replaceGoalConstraints(current, parsed.constraints)
      await store.save(next)
      const shown = next.status === "active"
        ? continuationPrompt(next)
        : `${owned}\n\nGoal Contract constraints:\n${next.constraints?.map((item) => `- ${item}`).join("\n") || "- none"}`
      if (shown !== owned) {
        replaceParts(output.parts, shown)
        translations.set(event.sessionID, { shown, owned })
      }
    }

    await notifyCommand(input.client, store, event.sessionID, parsed.action)
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const translation = translations.get(event.sessionID)
    if (!translation) {
      await chatHook(event, output)
      return
    }
    translations.delete(event.sessionID)
    const shown = textFromParts(output?.parts ?? [])
    if (shown !== translation.shown) {
      await chatHook(event, output)
      return
    }
    await chatHook(event, {
      ...output,
      parts: [{ type: "text", text: translation.owned }],
    })
  }
}
