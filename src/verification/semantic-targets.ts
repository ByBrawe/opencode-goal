// Conservative helpers for deciding what a *semantic* Goal actually asks to
// deliver. These are guardrails, not substitutes for the independent verifier.

const FILE_TOKEN = /\b(?:[a-zA-Z0-9_@.-]+[\\/])*[a-zA-Z0-9_@.-]+\.[a-zA-Z][a-zA-Z0-9]{0,8}\b/g

export function explicitFileTargets(text: string): string[] {
  return [...new Set((text.match(FILE_TOKEN) ?? []).map((value) => value.replace(/\\/g, "/")))]
}

export function requestsDeletion(text: string): boolean {
  return /\b(?:delete|deleting|remove|removing|unlink|erase)\b|\bsil(?:mek)?\b|\bkald[ıi]r\b/i.test(text)
}

/**
 * "Exactly N Goal turns" is a process contract.
 * "Implement X across N Goal turns" is a mixed contract: the count proves
 * only the process part, and real project evidence must prove X separately.
 *
 * Pure per-turn mutation instructions may be proven by host-owned mutation
 * fingerprints; otherwise an explicit create/write/update deliverable still
 * needs corroborated artifacts.
 */
export function needsConcreteDeliverable(text: string, perTurnMutation: boolean): boolean {
  if (/\b(?:implement|create|delete|deleting|remove|removing|ship|deliver|build|fix|refactor|publish|document)\b/i.test(text)) return true
  if (!perTurnMutation && /\b(?:write|update|modify|edit|add)\b/i.test(text)) return true
  return false
}
