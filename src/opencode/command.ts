import type { FileRequirementInput } from "../domain/types.js"

export interface ParsedGoalCommand {
  action: "create" | "status" | "pause" | "resume" | "clear" | "edit"
  objective: string
  acceptance: string[]
  checks: string[]
  files: FileRequirementInput[]
  maxTurns?: number
  maxTokens?: number
  maxRuntimeMs?: number
  maxCost?: number
}

function tokens(input: string): string[] {
  const result: string[] = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  for (const match of input.matchAll(re)) result.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1"))
  return result
}

function parseContainsContract(value: string): FileRequirementInput {
  const split = value.indexOf("::")
  if (split <= 0 || split === value.length - 2) throw new Error('--contains expects "path::exact text"')
  return { file: value.slice(0, split), contains: value.slice(split + 2) }
}

export function parseGoalCommand(input: string): ParsedGoalCommand {
  const list = tokens(input.trim())
  const sub = (list[0] ?? "").toLowerCase()
  if (["status", "pause", "resume", "clear"].includes(sub)) {
    return { action: sub as ParsedGoalCommand["action"], objective: "", acceptance: [], checks: [], files: [] }
  }
  let action: ParsedGoalCommand["action"] = "create"
  if (sub === "edit") { action = "edit"; list.shift() }
  const acceptance: string[] = []
  const checks: string[] = []
  const files: FileRequirementInput[] = []
  const objective: string[] = []
  let maxTurns: number | undefined
  let maxTokens: number | undefined
  let maxRuntimeMs: number | undefined
  let maxCost: number | undefined
  for (let i = 0; i < list.length; i += 1) {
    const current = list[i]!
    const next = list[i + 1]
    if ((current === "--accept" || current === "--acceptance") && next) { acceptance.push(next); i += 1; continue }
    if (current === "--check" && next) { checks.push(next); i += 1; continue }
    if (current === "--file" && next) { files.push({ file: next }); i += 1; continue }
    if (current === "--contains" && next) { files.push(parseContainsContract(next)); i += 1; continue }
    if (current === "--max-turns" && next) { maxTurns = Number.parseInt(next, 10); i += 1; continue }
    if (current === "--max-tokens" && next) { maxTokens = Number.parseInt(next, 10); i += 1; continue }
    if (current === "--max-minutes" && next) { maxRuntimeMs = Number.parseFloat(next) * 60_000; i += 1; continue }
    if (current === "--max-cost" && next) { maxCost = Number.parseFloat(next); i += 1; continue }
    if (current.startsWith("--")) throw new Error(`unknown goal option: ${current}`)
    objective.push(current)
  }
  const parsed: ParsedGoalCommand = { action, objective: objective.join(" ").trim(), acceptance, checks, files }
  if (maxTurns !== undefined && Number.isFinite(maxTurns) && maxTurns > 0) parsed.maxTurns = maxTurns
  if (maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0) parsed.maxTokens = maxTokens
  if (maxRuntimeMs !== undefined && Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) parsed.maxRuntimeMs = maxRuntimeMs
  if (maxCost !== undefined && Number.isFinite(maxCost) && maxCost > 0) parsed.maxCost = maxCost
  return parsed
}
