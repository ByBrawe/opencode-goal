import type CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { parseGoalCommand } from "./command.js"
import { showGoalToast } from "./toast.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type PromptTranslation = { shown: string; owned: string }

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function conflictMessage(goal: GoalState): string {
  const resume = goal.status === "paused" ? "\n- /goal resume — resume the current paused Goal." : ""
  return [
    "New Goal not created: this session already has an unfinished Goal.",
    `Current Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    "",
    "Choose explicitly before starting another Goal:",
    `- /goal status — inspect the current Goal.${resume}`,
    "- /goal edit <objective> — intentionally revise the current Goal contract.",
    "- /goal add <objective> — queue another Goal without replacing the current one.",
    "- /goal clear — archive/clear the current Goal; then run /goal <objective> again.",
    "",
    "No Goal state was changed by this command.",
  ].join("\n")
}

function pausedMessage(goal: GoalState): string {
  return [
    "Goal paused. Autonomous Goal continuation is now off.",
    `Current Goal: ${goal.objective}`,
    "",
    "To continue this persisted Goal, run:",
    "/goal resume",
    "",
    "A normal chat message such as \"devam et\" or \"continue\" does not change the persisted Goal state to active; it is handled as a normal foreground user message.",
    "Use /goal clear only when you intentionally want to stop tracking this Goal and start another one.",
  ].join("\n")
}

function pausedNoticeKey(goal: GoalState): string {
  return `${goal.id}:${goal.revision}:${goal.stopReason ?? ""}`
}

function isSyntheticHostMessage(parts: any[]): boolean {
  return parts.some((part) => part?.synthetic === true)
}

export function installGoalLifecycleUX(input: PluginInput, hooks: PluginHooks): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const store = new GoalStore(input.directory)
  const translations = new Map<string, PromptTranslation>()
  const pausedChatNotices = new Map<string, string>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    let parsed: ReturnType<typeof parseGoalCommand>
    try {
      parsed = parseGoalCommand(event.arguments ?? "")
    } catch {
      await commandHook(event, output)
      return
    }

    if (parsed.action === "create" && parsed.objective) {
      const goal = await store.load(event.sessionID)
      if (goal && goal.status !== "completed") {
        // Seed the existing command-ownership chain through a read-only status
        // command, then translate only the user-visible text. This keeps the
        // warning from being mistaken for a normal human message that pauses
        // or mutates the current Goal.
        await commandHook({ ...event, arguments: "status" }, output)
        const owned = textFromParts(output.parts)
        const shown = conflictMessage(goal)
        ;(output as any).noReply = true
        replaceParts(output.parts, shown)
        translations.set(event.sessionID, { shown, owned })
        await showGoalToast(input.client, "An unfinished Goal already exists. Use /goal status, /goal resume, /goal add, or /goal clear.", "warning")
        return
      }
    }

    if (parsed.action === "pause") {
      pausedChatNotices.delete(event.sessionID)
      await commandHook(event, output)
      const goal = await store.load(event.sessionID)
      if (!goal || goal.status !== "paused") return
      const owned = textFromParts(output.parts)
      const shown = pausedMessage(goal)
      ;(output as any).noReply = true
      replaceParts(output.parts, shown)
      translations.set(event.sessionID, { shown, owned })
      await showGoalToast(input.client, "Goal paused. Use /goal resume to restart autonomous continuation.", "info")
      return
    }

    await commandHook(event, output)
    if (["create", "edit", "resume", "clear"].includes(parsed.action)) pausedChatNotices.delete(event.sessionID)
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const shown = textFromParts(output?.parts ?? [])
    const translation = translations.get(event.sessionID)
    if (translation && shown === translation.shown) {
      translations.delete(event.sessionID)
      await chatHook(event, {
        ...output,
        parts: [{ type: "text", text: translation.owned }],
      })
      return
    }

    await chatHook(event, output)

    // Read-only/status commands and host-generated synthetic task notifications
    // are not foreground user steering. Do not nag on those internal messages.
    if ((output as any)?.noReply === true || isSyntheticHostMessage(output?.parts ?? [])) return

    const goal = await store.load(event.sessionID)
    if (!goal || goal.status !== "paused") {
      pausedChatNotices.delete(event.sessionID)
      return
    }

    const key = pausedNoticeKey(goal)
    if (pausedChatNotices.get(event.sessionID) === key) return
    pausedChatNotices.set(event.sessionID, key)
    await showGoalToast(
      input.client,
      "Goal remains paused. This chat turn does not resume autonomous Goal work. Use /goal resume to continue the persisted Goal.",
      "warning",
    )
  }
}
