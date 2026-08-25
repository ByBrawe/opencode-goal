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
    "To continue this persisted Goal, either run /goal resume or tell the agent to continue in your normal language.",
    "Natural-language continuation is interpreted by the model through the Goal resume tool; lifecycle code does not use a language-specific phrase list.",
    "Questions and unrelated foreground chat do not directly mutate Goal state.",
    "Use /goal clear only when you intentionally want to stop tracking this Goal and start another one.",
  ].join("\n")
}

function commandErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return [
    "Goal command was not run because its arguments are invalid.",
    `Reason: ${detail}`,
    "",
    "No Goal state was changed.",
    "Fix the command and try again. Long pasted specifications may be pasted directly after /goal; meaningful multiline content is treated as literal Goal text rather than command flags.",
    "Respond with this error only; do not perform work.",
  ].join("\n")
}

export function installGoalLifecycleUX(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const translations = new Map<string, PromptTranslation>()
  const commandOutputs = new Map<string, string>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    let parsed: ReturnType<typeof parseGoalCommand>
    try {
      parsed = parseGoalCommand(event.arguments ?? "")
    } catch (error) {
      // Seed the core command ownership with a safe read-only prompt, then swap
      // only the host-visible/model-visible presentation. This prevents a
      // malformed slash command from escaping as a command.execute.before hook
      // exception (which recent OpenCode TUI versions can render as an empty or
      // failed command turn) while also preventing the synthetic error message
      // from being mistaken for ordinary foreground Goal steering.
      await commandHook({ ...event, arguments: "status" }, output)
      const owned = textFromParts(output.parts)
      const shown = commandErrorMessage(error)
      ;(output as any).noReply = false
      replaceParts(output.parts, shown)
      translations.set(event.sessionID, { shown, owned })
      await showGoalToast(input.client, error instanceof Error ? error.message : "Invalid /goal command.", "error")
      return
    }

    if (parsed.action === "create" && parsed.objective) {
      const goal = await store.load(event.sessionID)
      if (goal && goal.status !== "completed") {
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
      await commandHook(event, output)
      const goal = await store.load(event.sessionID)
      if (!goal || goal.status !== "paused") return
      const owned = textFromParts(output.parts)
      const shown = pausedMessage(goal)
      ;(output as any).noReply = true
      replaceParts(output.parts, shown)
      translations.set(event.sessionID, { shown, owned })
      await showGoalToast(input.client, "Goal paused. Use /goal resume or tell the agent to continue in your normal language.", "info")
      return
    }

    await commandHook(event, output)
    const commandOutput = textFromParts(output?.parts ?? [])
    if (commandOutput) commandOutputs.set(event.sessionID, commandOutput)
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

    const commandOutput = commandOutputs.get(event.sessionID)
    if (commandOutput) {
      commandOutputs.delete(event.sessionID)
      if (shown === commandOutput) {
        await chatHook(event, output)
        return
      }
    }

    await chatHook(event, output)
  }
}
