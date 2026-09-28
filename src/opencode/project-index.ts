import type CorePlugin from "./plugin.js"
import type { GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { parseGoalCommand } from "./command.js"
import { formatDetailedGoalStatus } from "./controls.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type PromptTranslation = { shown: string; owned: string }

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function sortProjectGoals(goals: GoalState[], currentSessionID: string): GoalState[] {
  return [...goals].sort((left, right) => {
    const leftCurrent = left.sessionID === currentSessionID ? 1 : 0
    const rightCurrent = right.sessionID === currentSessionID ? 1 : 0
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.localeCompare(right.id)
  })
}

function projectGoalLine(goal: GoalState, currentSessionID: string): string {
  const current = goal.sessionID === currentSessionID ? "*" : " "
  return `${current} ${goal.id.slice(0, 12)} [${goal.status}] session:${goal.sessionID.slice(0, 12)} ${new Date(goal.updatedAt).toISOString()} — ${goal.objective}`
}

export function formatProjectGoalIndex(goals: GoalState[], currentSessionID: string, selector?: string): string {
  const ordered = sortProjectGoals(goals, currentSessionID)
  if (!selector) {
    if (!ordered.length) return "No live Goal snapshots in this project."
    const shown = ordered.slice(0, 20)
    const more = ordered.length > shown.length ? `\n… and ${ordered.length - shown.length} more live Goal snapshot(s).` : ""
    return `Project Goal snapshots (* = current session):\n${shown.map((goal) => projectGoalLine(goal, currentSessionID)).join("\n")}${more}`
  }

  const normalized = selector.trim().toLowerCase()
  const matches = ordered.filter((goal) => goal.id.toLowerCase().startsWith(normalized))
  if (!matches.length) return `No live project Goal matches "${selector}".`

  const matchingIDs = [...new Set(matches.map((goal) => goal.id))]
  if (matchingIDs.length > 1) {
    const representatives = matchingIDs
      .map((id) => matches.find((goal) => goal.id === id)!)
      .slice(0, 20)
    return `Multiple live project Goals match "${selector}". Use a longer Goal id prefix:\n${representatives.map((goal) => projectGoalLine(goal, currentSessionID)).join("\n")}`
  }

  const chain = matches
    .filter((goal) => goal.id === matchingIDs[0])
    .sort((left, right) => {
      const leftIndex = left.unitRotation?.chainIndex
      const rightIndex = right.unitRotation?.chainIndex
      if (leftIndex !== undefined || rightIndex !== undefined) {
        return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER)
      }
      return left.updatedAt - right.updatedAt
    })
  const goal = chain.find((item) => item.sessionID === currentSessionID && item.status !== "handed_off" && item.status !== "handoff_pending")
    ?? chain.find((item) => item.status !== "handed_off" && item.status !== "handoff_pending")
    ?? chain[chain.length - 1]!
  const current = goal.sessionID === currentSessionID ? " (current session)" : ""

  if (chain.length === 1) {
    return `Project Goal: ${goal.id}\nSession: ${goal.sessionID}${current}\nUpdated: ${new Date(goal.updatedAt).toISOString()}\n${formatDetailedGoalStatus(goal)}`
  }

  return [
    `Project Goal: ${goal.id}`,
    `Session chain: ${chain.length} snapshots`,
    ...chain.map((item) => projectGoalLine(item, currentSessionID)),
    `Logical owner: ${goal.sessionID}${current}`,
    formatDetailedGoalStatus(goal),
  ].join("\n")
}

export function installProjectGoalIndex(input: PluginInput, hooks: PluginHooks): void {
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
    if (parsed.action !== "list") {
      await commandHook(event, output)
      return
    }

    // Let the lower Goal control layer seed command ownership through its
    // existing read-only status path, then translate only the visible response.
    // This keeps `/goal list` from looking like user intervention to the active
    // current-session Goal without granting it any mutation path.
    await commandHook({ ...event, arguments: "status" }, output)
    const ownedText = textFromParts(output.parts)
    const goals = await store.list()
    const shown = `${formatProjectGoalIndex(goals, event.sessionID, parsed.goalIDPrefix)}\nRespond with this project Goal index only; do not perform work.`
    replaceParts(output.parts, shown)
    translations.set(event.sessionID, { shown, owned: ownedText })
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
