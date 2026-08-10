import type CorePlugin from "./plugin.js"
import type { GoalBudget, GoalState } from "../domain/types.js"
import type { GoalSequenceState, QueuedGoalSpec } from "../domain/sequence.js"
import { GoalStore } from "../persistence/store.js"
import { GoalSequenceStore } from "../persistence/sequence-store.js"
import { parseGoalCommand } from "./command.js"
import { showGoalToast } from "./toast.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type PromptTranslation = { shown: string; owned: string }

type SequenceAction = "add" | "queue" | "queue_remove" | "queue_move" | "queue_clear" | "next"

const SEQUENCE_ACTIONS = new Set<SequenceAction>(["add", "queue", "queue_remove", "queue_move", "queue_clear", "next"])

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function shortID(value: string): string {
  return value.slice(0, 12)
}

function queueLine(item: QueuedGoalSpec, index: number): string {
  return `${index + 1}. ${shortID(item.id)} [${item.activating ? "activating" : "queued"}] ${item.objective}`
}

export function formatGoalSequence(current: GoalState | null, sequence: GoalSequenceState): string {
  const live = current
    ? `${shortID(current.id)} [${current.status}] ${current.objective}`
    : "none"
  const queued = sequence.items.length ? sequence.items.map(queueLine).join("\n") : "- none"
  return `Goal Sequence\nCurrent: ${live}\nPending: ${sequence.items.length}\n\nOrdered queue:\n${queued}\n\nOnly one Goal can be live/active at a time. Pending Goals are inert contracts until promoted in order.`
}

function budgetPatch(parsed: ReturnType<typeof parseGoalCommand>): Partial<GoalBudget> {
  const budget: Partial<GoalBudget> = {}
  if (parsed.maxTurns !== undefined) budget.maxTurns = parsed.maxTurns
  if (parsed.maxTokens !== undefined) budget.maxTokens = parsed.maxTokens
  if (parsed.maxRuntimeMs !== undefined) budget.maxRuntimeMs = parsed.maxRuntimeMs
  if (parsed.maxCost !== undefined) budget.maxCost = parsed.maxCost
  return budget
}

function eventSessionID(input: any): string | undefined {
  const properties = input?.event?.properties ?? {}
  const value = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  return typeof value === "string" && value ? value : undefined
}

function translatedOutput(output: any, text: string, owned: string, translations: Map<string, PromptTranslation>, sessionID: string) {
  replaceParts(output.parts, text)
  translations.set(sessionID, { shown: text, owned })
}

function selectorFailure(prefix: string, result: { reason: string; matches: QueuedGoalSpec[] }): string {
  if (result.reason === "not_found") return `No queued Goal matches "${prefix}".`
  if (result.reason === "ambiguous") return `Multiple queued Goals match "${prefix}". Use a longer id prefix:\n${result.matches.map((item, index) => queueLine(item, index)).join("\n")}`
  if (result.reason === "position") return "Queue position is outside the current ordered queue."
  return "That queued Goal is currently being activated. Retry after activation settles."
}

export function installGoalSequence(input: PluginInput, hooks: PluginHooks): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  const eventHook = hooks.event
  if (typeof commandHook !== "function" || typeof chatHook !== "function" || typeof eventHook !== "function") return

  const goals = new GoalStore(input.directory)
  const sequences = new GoalSequenceStore(input.directory)
  const translations = new Map<string, PromptTranslation>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    const parsed = parseGoalCommand(event.arguments ?? "")
    if (!SEQUENCE_ACTIONS.has(parsed.action as SequenceAction)) {
      await commandHook(event, output)
      return
    }

    if (parsed.action === "next") {
      const promoted = await sequences.promoteNext(event.sessionID)
      if (promoted.ok) {
        await commandHook({ ...event, arguments: "resume" }, output)
        return
      }

      await commandHook({ ...event, arguments: "status" }, output)
      const owned = textFromParts(output.parts)
      const shown = promoted.reason === "empty"
        ? "Goal queue is empty. Nothing was activated."
        : `Cannot activate the next queued Goal while an unfinished Goal is current.\nCurrent: ${shortID(promoted.current.id)} [${promoted.current.status}] ${promoted.current.objective}`
      translatedOutput(output, `${shown}\nRespond with this sequence status only; do not perform work.`, owned, translations, event.sessionID)
      return
    }

    // Seed core command ownership with a read-only status prompt so queue-only
    // commands do not look like unrelated user intervention to the Goal runtime.
    await commandHook({ ...event, arguments: "status" }, output)
    const owned = textFromParts(output.parts)
    let shown: string

    if (parsed.action === "add") {
      if (!parsed.objective) throw new Error("Usage: /goal add <objective> [Goal Contract options]")
      const result = await sequences.enqueue(event.sessionID, {
        objective: parsed.objective,
        acceptance: parsed.acceptance,
        constraints: parsed.constraints,
        checks: parsed.checks,
        files: parsed.files,
        budget: budgetPatch(parsed),
      })
      shown = `Queued Goal ${shortID(result.item.id)} at position ${result.sequence.items.length}: ${result.item.objective}\nPending Goals: ${result.sequence.items.length}`
    } else if (parsed.action === "queue") {
      shown = formatGoalSequence(await goals.load(event.sessionID), await sequences.load(event.sessionID))
    } else if (parsed.action === "queue_remove") {
      const result = await sequences.remove(event.sessionID, parsed.goalIDPrefix!)
      shown = result.ok
        ? `Removed queued Goal ${shortID(result.item.id)}: ${result.item.objective}\nPending Goals: ${result.sequence.items.length}`
        : selectorFailure(parsed.goalIDPrefix!, result)
    } else if (parsed.action === "queue_move") {
      const result = await sequences.move(event.sessionID, parsed.goalIDPrefix!, parsed.queuePosition!)
      shown = result.ok
        ? `Moved queued Goal ${shortID(result.item.id)} to position ${result.position}.\n${formatGoalSequence(await goals.load(event.sessionID), result.sequence)}`
        : selectorFailure(parsed.goalIDPrefix!, result)
    } else {
      const result = await sequences.clear(event.sessionID)
      shown = result.ok
        ? `Cleared ${result.removed.length} queued Goal(s). The current live Goal was not changed.`
        : "Cannot clear the queue while its head Goal is being activated. Retry after activation settles."
    }

    translatedOutput(output, `${shown}\nRespond with this sequence status only; do not perform work.`, owned, translations, event.sessionID)
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
    await chatHook(event, { ...output, parts: [{ type: "text", text: translation.owned }] })
  }

  // Promotion happens at the idle boundary, never inside the completing
  // assistant turn. That prevents the old Goal turn from mutating or claiming
  // progress for the newly activated Goal after completion.
  hooks.event = async (eventInput: any) => {
    const type = String(eventInput?.event?.type ?? "")
    const sessionID = eventSessionID(eventInput)
    if (type === "session.idle" && sessionID) {
      const current = await goals.load(sessionID)
      if (current?.status === "completed" && current.execution?.agent && current.execution.agent.trim().toLowerCase() !== "plan") {
        try {
          const promoted = await sequences.promoteNext(sessionID)
          if (promoted.ok) {
            await showGoalToast(input.client, `Sequence advanced: ${promoted.goal.objective}`, "success")
          }
        } catch {
          await showGoalToast(input.client, "Goal sequence could not advance safely. Run /goal doctor.", "warning")
        }
      }
    }
    await eventHook(eventInput)
  }
}
