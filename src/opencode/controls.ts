import type CorePlugin from "./plugin.js"
import type { GoalBudget, GoalState } from "../domain/types.js"
import { GoalStore, type GoalArchiveRecord } from "../persistence/store.js"
import { applyGoalBudget, budgetLimitHits, formatGoalBudget } from "../runtime/accounting.js"
import { parseGoalCommand } from "./command.js"
import { continuationPrompt } from "./prompt.js"

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

function archiveLine(record: GoalArchiveRecord): string {
  const id = record.goalID.slice(0, 12)
  const when = new Date(record.archivedAt).toISOString()
  return `${id} [${record.goal.status}; ${record.reason}] ${when} — ${record.goal.objective}`
}

export function formatGoalHistory(records: GoalArchiveRecord[], selector?: string): string {
  if (!selector) {
    if (!records.length) return "No archived goals."
    const shown = records.slice(0, 10)
    const more = records.length > shown.length ? `\n… and ${records.length - shown.length} more archived goal(s).` : ""
    return `Archived goals (newest first):\n${shown.map(archiveLine).join("\n")}${more}`
  }

  const normalized = selector.toLowerCase()
  const matches = records.filter((record) => record.goalID.toLowerCase().startsWith(normalized))
  if (!matches.length) return `No archived goal matches "${selector}".`
  if (matches.length > 1) {
    return `Multiple archived goals match "${selector}". Use a longer id prefix:\n${matches.slice(0, 10).map(archiveLine).join("\n")}`
  }

  const record = matches[0]!
  return `Archived goal: ${record.goalID}\nArchive reason: ${record.reason}\nArchived at: ${new Date(record.archivedAt).toISOString()}\n${formatDetailedGoalStatus(record.goal)}`
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

async function applyParsedBudgetAfterCore(
  store: GoalStore,
  parsed: ReturnType<typeof parseGoalCommand>,
  event: any,
  output: any,
  translations: Map<string, PromptTranslation>,
): Promise<void> {
  const patch = budgetPatch(parsed)
  if (!Object.keys(patch).length) return
  const current = await store.load(event.sessionID)
  if (!current) return
  const next = applyGoalBudget(current, patch)
  await store.save(next)

  const ownedText = textFromParts(output.parts)
  if (next.status === "active") {
    const shown = continuationPrompt(next)
    if (shown !== ownedText) translatedOutput(output, shown, ownedText, translations, event.sessionID)
    return
  }

  output.noReply = true
  const shown = `${formatDetailedGoalStatus(next)}\nRespond with this status only; do not perform work.`
  translatedOutput(output, shown, ownedText, translations, event.sessionID)
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
    if (parsed.action === "history") {
      await commandHook({ ...event, arguments: "status" }, output)
      const ownedText = textFromParts(output.parts)
      const records = await store.history(event.sessionID, 500)
      const shown = `${formatGoalHistory(records, parsed.historySelector)}\nRespond with this history only; do not perform work.`
      translatedOutput(output, shown, ownedText, translations, event.sessionID)
      return
    }

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

    if (parsed.action === "create" || parsed.action === "edit") {
      await commandHook(event, output)
      await applyParsedBudgetAfterCore(store, parsed, event, output, translations)
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
      const ownedText = textFromParts(output.parts)
      const shown = continuationPrompt(next)
      if (shown !== ownedText) translatedOutput(output, shown, ownedText, translations, event.sessionID)
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
