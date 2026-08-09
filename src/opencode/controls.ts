import type CorePlugin from "./plugin.js"
import type { GoalBudget, GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { applyGoalBudget, budgetLimitHits, formatGoalBudget } from "../runtime/accounting.js"
import { parseGoalCommand } from "./command.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type PromptTranslation = { shown: string; owned: string }

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

export function formatDetailedGoalStatus(goal: GoalState | null): string {
  if (!goal) return "No active goal."
  const req = goal.requirements.map((item, i) => `${i + 1}. [${item.status}] ${item.text}`).join("\n")
  const stop = goal.stopReason ? `\nStop reason: ${goal.stopReason}` : ""
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nBudget: ${formatGoalBudget(goal)}${stop}\nRequirements:\n${req}`
}

function budgetPatch(parsed: ReturnType<typeof parseGoalCommand>): Partial<GoalBudget> {
  const patch: Partial<GoalBudget> = {}
  if (parsed.maxTurns !== undefined) patch.maxTurns = parsed.maxTurns
  if (parsed.maxTokens !== undefined) patch.maxTokens = parsed.maxTokens
  if (parsed.maxRuntimeMs !== undefined) patch.maxRuntimeMs = parsed.maxRuntimeMs
  if (parsed.maxCost !== undefined) patch.maxCost = parsed.maxCost
  return patch
}

function translatedOutput(output: any, text: string, ownedText: string, translations: Map<string, PromptTranslation>, sessionID: string) {
  replaceParts(output.parts, text)
  translations.set(sessionID, { shown: text, owned: ownedText })
}

export function enhanceGoalControls(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const translations = new Map<string, PromptTranslation>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    const parsed = parseGoalCommand(event.arguments ?? "")
    if (parsed.action === "status") {
      await commandHook(event, output)
      const ownedText = textFromParts(output.parts)
      translatedOutput(output, `${formatDetailedGoalStatus(await store.load(event.sessionID))}\nRespond with this status only; do not perform work.`, ownedText, translations, event.sessionID)
      return
    }

    if (parsed.action === "resume") {
      const goal = await store.load(event.sessionID)
      if (goal?.status === "budget_limited" && budgetLimitHits(goal.usage, goal.budget).length) {
        await commandHook({ ...event, arguments: "status" }, output)
        const ownedText = textFromParts(output.parts)
        const text = `${formatDetailedGoalStatus(goal)}\nBudget is still exhausted. Increase or clear the reached limit with /goal budget before resuming. Respond with this status only; do not perform work.`
        translatedOutput(output, text, ownedText, translations, event.sessionID)
        return
      }
      await commandHook(event, output)
      return
    }

    if (parsed.action !== "budget") {
      await commandHook(event, output)
      return
    }

    const existing = await store.load(event.sessionID)
    if (!existing) {
      await commandHook({ ...event, arguments: "status" }, output)
      const ownedText = textFromParts(output.parts)
      translatedOutput(output, "No active goal. Respond with this status only; do not perform work.", ownedText, translations, event.sessionID)
      return
    }

    const patch = budgetPatch(parsed)
    if (!Object.keys(patch).length) {
      await commandHook({ ...event, arguments: "status" }, output)
      const ownedText = textFromParts(output.parts)
      translatedOutput(output, `${formatDetailedGoalStatus(existing)}\nRespond with this status only; do not perform work.`, ownedText, translations, event.sessionID)
      return
    }

    const beforeStatus = existing.status
    const next = applyGoalBudget(existing, patch)
    await store.save(next)

    if (beforeStatus === "budget_limited" && next.status === "active") {
      // Ask the core hook to seed TurnOwnership for the exact continuation text,
      // but restore our budget-updated snapshot because resumeGoal() also resets
      // no-progress accounting that a budget change must not erase.
      await commandHook({ ...event, arguments: "resume" }, output)
      await store.save(next)
      return
    }

    await commandHook({ ...event, arguments: "status" }, output)
    const ownedText = textFromParts(output.parts)
    const text = `${formatDetailedGoalStatus(next)}\nRespond with this status only; do not perform work.`
    translatedOutput(output, text, ownedText, translations, event.sessionID)
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
    const cloned = {
      ...output,
      parts: [{ type: "text", text: translation.owned }],
    }
    await chatHook(event, cloned)
  }
}
