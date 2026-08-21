import type CorePlugin from "./plugin.js"
import type { GoalBudget, GoalRequirement, GoalState } from "../domain/types.js"
import { diagnoseGoalStorage, type GoalStorageDiagnosticReport } from "../persistence/diagnostics.js"
import { GoalStore, type GoalArchiveRecord, type GoalHistoryPruneResult, type GoalRestoreResult } from "../persistence/store.js"
import { applyGoalBudget, budgetLimitHits, formatGoalBudget } from "../runtime/accounting.js"
import { formatModelContext } from "../runtime/model-context.js"
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
  return `Goal: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nBudget: ${formatGoalBudget(goal)}\nModel context: ${formatModelContext(goal)}${stop}\nRequirements:\n${req}`
}

function acceptanceRequirements(goal: GoalState): GoalRequirement[] {
  const semantic = goal.requirements.filter((item) => item.verification === "semantic")
  return semantic.filter((item, index) => item.source === "acceptance" || (!item.source && index > 0))
}

function goalConstraints(goal: GoalState): string[] {
  if (Array.isArray(goal.constraints)) return goal.constraints
  return goal.requirements
    .filter((item) => item.source === "constraint")
    .map((item) => item.text.replace(/^Constraint preserved:\s*/i, "").trim())
    .filter(Boolean)
}

function requirementLines(items: GoalRequirement[], emptyText: string): string {
  if (!items.length) return `- ${emptyText}`
  return items.map((item) => `- [${item.status}] ${item.text}`).join("\n")
}

export function formatGoalContract(goal: GoalState | null): string {
  if (!goal) return "No active goal contract."
  const acceptance = acceptanceRequirements(goal)
  const constraints = goalConstraints(goal)
  const hostContracts = goal.requirements.filter((item) => item.verification === "command" || item.verification === "file")
  const constraintLines = constraints.length ? constraints.map((item) => `- ${item}`).join("\n") : "- none declared"
  return `Goal Contract\nObjective: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\n\nSuccess criteria:\n${requirementLines(acceptance, "none declared beyond the full objective")}\n\nConstraints / non-goals:\n${constraintLines}\n\nHost verification contracts:\n${requirementLines(hostContracts, "none declared")}\n\nBudget: ${formatGoalBudget(goal)}\n\nThe full objective and every declared constraint remain required for completion.`
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

function formatHistoryPrune(result: GoalHistoryPruneResult): string {
  if (!result.removed.length) {
    return `Goal history already fits the requested retention. Kept ${result.kept.length} archived Goal(s); removed 0.`
  }
  const shown = result.removed.slice(0, 10)
  const more = result.removed.length > shown.length ? `\n… and ${result.removed.length - shown.length} more removed archive(s).` : ""
  return `Pruned Goal history: kept ${result.kept.length} newest archived Goal(s); removed ${result.removed.length} older archive(s).\nRemoved:\n${shown.map(archiveLine).join("\n")}${more}`
}

function diagnosticIssueLine(issue: GoalStorageDiagnosticReport["issues"][number]): string {
  return `- ${issue.scope}: ${issue.kind} at ${issue.file} — ${issue.detail}`
}

export function formatGoalDoctor(report: GoalStorageDiagnosticReport): string {
  const live = report.live.state === "missing"
    ? "missing"
    : report.live.state === "valid"
      ? `valid (${report.live.goal.id.slice(0, 12)}, ${report.live.goal.status}, revision ${report.live.goal.revision})`
      : `INVALID (${report.live.issue.kind})`
  const archives = report.archives.state === "valid"
    ? `valid (${report.archives.count} record(s))`
    : `INVALID (${report.archives.issue.kind})`
  const queue = report.queue.state === "missing"
    ? "missing"
    : report.queue.state === "valid"
      ? `valid (${report.queue.count} pending; generation ${report.queue.generation})`
      : `INVALID (${report.queue.issue.kind})`
  const issues = report.issues.length
    ? `\nIssues:\n${report.issues.map(diagnosticIssueLine).join("\n")}`
    : ""
  return `Goal storage doctor: ${report.issues.length ? "ISSUES FOUND" : "OK"}\nLive snapshot: ${live}\nArchive storage: ${archives}\nQueue storage: ${queue}${issues}\nNo files were modified.`
}

function formatRestoreResult(result: GoalRestoreResult, selector: string): string {
  if (result.ok) {
    return `Restored archived goal ${result.goal.id} as paused.\n${formatDetailedGoalStatus(result.goal)}\nUse /goal resume to continue this Goal.`
  }
  if (result.reason === "not_found") return `No archived goal matches "${selector}". Nothing was restored.`
  if (result.reason === "ambiguous") {
    return `Multiple archived goals match "${selector}". Use a longer id prefix:\n${result.matches.slice(0, 10).map(archiveLine).join("\n")}`
  }
  if (result.reason === "live_unfinished") {
    return `Cannot restore while an unfinished Goal is current.\n${formatDetailedGoalStatus(result.current)}\nFinish or /goal clear the current Goal before restoring another one.`
  }
  if (result.reason === "already_current") {
    return `Goal ${result.current.id} is already the current Goal. Nothing was restored.\n${formatDetailedGoalStatus(result.current)}`
  }
  return `Archived goal ${result.source.goalID} is already completed and cannot be restored. Inspect it with /goal history ${result.source.goalID.slice(0, 12)}.`
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
  const readOnlyResponses = new Map<string, string>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    const parsed = parseGoalCommand(event.arguments ?? "")
    if (parsed.action === "doctor") {
      const shown = `${formatGoalDoctor(await diagnoseGoalStorage(input.directory, event.sessionID))}\nRespond with this diagnostic only; do not perform work.`
      output.noReply = true
      replaceParts(output.parts, shown)
      readOnlyResponses.set(event.sessionID, shown)
      return
    }

    if (parsed.action === "contract") {
      const shown = `${formatGoalContract(await store.load(event.sessionID))}\nRespond with this contract only; do not perform work.`
      output.noReply = true
      replaceParts(output.parts, shown)
      readOnlyResponses.set(event.sessionID, shown)
      return
    }

    if (parsed.action === "history") {
      await commandHook({ ...event, arguments: "status" }, output)
      const ownedText = textFromParts(output.parts)
      const records = await store.history(event.sessionID, 500)
      const shown = `${formatGoalHistory(records, parsed.goalIDPrefix)}\nRespond with this history only; do not perform work.`
      translatedOutput(output, shown, ownedText, translations, event.sessionID)
      return
    }

    if (parsed.action === "history_prune") {
      await commandHook({ ...event, arguments: "status" }, output)
      const ownedText = textFromParts(output.parts)
      const result = await store.pruneHistory(event.sessionID, parsed.historyKeep!)
      const shown = `${formatHistoryPrune(result)}\nRespond with this history-prune status only; do not perform work.`
      translatedOutput(output, shown, ownedText, translations, event.sessionID)
      return
    }

    if (parsed.action === "restore") {
      await commandHook({ ...event, arguments: "status" }, output)
      const ownedText = textFromParts(output.parts)
      const result = await store.restore(event.sessionID, parsed.goalIDPrefix!)
      const shown = `${formatRestoreResult(result, parsed.goalIDPrefix!)}\nRespond with this restore status only; do not perform work.`
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
      await commandHook({ ...event, arguments: "resume" }, output)
      const resumed = await store.load(event.sessionID)
      if (!resumed || resumed.id !== next.id || resumed.revision !== next.revision || resumed.status !== "active") {
        throw new Error("Goal changed while seeding budget-resume ownership")
      }
      next.storageGeneration = resumed.storageGeneration ?? 0
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
    const shown = textFromParts(output?.parts ?? [])
    const readOnly = readOnlyResponses.get(event.sessionID)
    if (readOnly) {
      readOnlyResponses.delete(event.sessionID)
      if (shown === readOnly) return
    }

    const translation = translations.get(event.sessionID)
    if (!translation) {
      await chatHook(event, output)
      return
    }
    translations.delete(event.sessionID)
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
