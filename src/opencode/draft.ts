import type CorePlugin from "./plugin.js"
import { createGoal, pauseGoal } from "../domain/goal.js"
import { GoalStore } from "../persistence/store.js"
import { parseGoalCommand } from "./command.js"
import { formatGoalContract } from "./controls.js"
import { showGoalToast } from "./toast.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type PromptTranslation = { shown: string; owned: string }

const DRAFT_STOP_REASON = "Goal draft saved. Run /goal resume to execute."

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function budgetFrom(parsed: ReturnType<typeof parseGoalCommand>) {
  return {
    ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    ...(parsed.maxRuntimeMs !== undefined ? { maxRuntimeMs: parsed.maxRuntimeMs } : {}),
    ...(parsed.maxCost !== undefined ? { maxCost: parsed.maxCost } : {}),
  }
}

/**
 * Persist a complete Goal Contract without ever exposing an active execution
 * state. The existing read-only status command is reused only to seed the core
 * command-ownership protocol after the paused draft has been durably written.
 */
export function installGoalDraft(input: PluginInput, hooks: PluginHooks): void {
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
    if (parsed.action !== "draft") {
      await commandHook(event, output)
      return
    }
    if (!parsed.objective) {
      throw new Error('Usage: /goal draft <objective> [--success "criterion"] [--constraint "boundary"] [--check "command"]')
    }

    const current = await store.load(event.sessionID)
    if (current && current.status !== "completed") {
      throw new Error("An unfinished goal already exists. Finish it or /goal clear it before drafting another Goal.")
    }

    const drafted = pauseGoal(createGoal({
      sessionID: event.sessionID,
      objective: parsed.objective,
      acceptance: parsed.acceptance,
      constraints: parsed.constraints,
      checks: parsed.checks,
      files: parsed.files,
      budget: budgetFrom(parsed),
    }), DRAFT_STOP_REASON)
    await store.save(drafted)

    // Seed the established command-ownership chain only after the persisted
    // snapshot is already paused. No idle/restart path can observe this draft
    // as active, even transiently.
    await commandHook({ ...event, arguments: "status" }, output)
    const owned = textFromParts(output.parts)
    const shown = `${formatGoalContract(drafted)}\n\nDraft saved paused. Review with /goal contract; run /goal resume explicitly when execution should begin.\nRespond only with OK.`
    replaceParts(output.parts, shown)
    translations.set(event.sessionID, { shown, owned })
    await showGoalToast(input.client, `Goal draft saved: ${drafted.objective}`, "info")
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
