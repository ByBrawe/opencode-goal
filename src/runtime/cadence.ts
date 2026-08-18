import type { GoalState } from "../domain/types.js"

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[ıİ]/g, "i")
    .replace(/[şŞ]/g, "s")
    .replace(/[ğĞ]/g, "g")
    .replace(/[çÇ]/g, "c")
    .replace(/[öÖ]/g, "o")
    .replace(/[üÜ]/g, "u")
}

const READ_ONLY_SHELL_PREFIXES = [
  "get-content",
  "get-childitem",
  "get-child-item",
  "get-item",
  "get-location",
  "resolve-path",
  "test-path",
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "dir",
  "pwd",
]

export function isClearlyReadOnlyShellCommand(command: unknown): boolean {
  if (typeof command !== "string") return false
  const text = command.trim()
  if (!text) return false

  // Keep this intentionally conservative. Any chaining, piping, redirection,
  // command substitution, or multiline script falls back to the cadence guard.
  if (/[\r\n;&|><`]/.test(text) || /\$\(/.test(text)) return false

  const normalized = text.toLowerCase()
  return READ_ONLY_SHELL_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix} `),
  )
}

export function requiresDistinctGoalTurnCadence(goal: Pick<GoalState, "objective"> | string): boolean {
  const text = fold(typeof goal === "string" ? goal : goal.objective)
  const goalTurn = String.raw`goal\s+(?:turns?|turn|turu|turunda|turlar|tur)`
  const counted = new RegExp(String.raw`\b\d+\s+(?:(?:ayri|separate|distinct)\s+)?${goalTurn}\b`)
  const perTurn = new RegExp(String.raw`\b(?:her|each|every|per)\s+${goalTurn}\b`)
  const qualified = new RegExp(String.raw`\b(?:ayri|separate|distinct)\b[\s\S]{0,48}\b${goalTurn}\b`)
  return counted.test(text) || perTurn.test(text) || qualified.test(text)
}

export const CADENCE_BOUNDARY_MESSAGE = "Goal cadence boundary: this objective requires work across distinct Goal turns, so only one successful workspace mutation is allowed in the current Goal turn. End this assistant turn now; OpenCode Goals will continue automatically in the next Goal turn."
