import type { FileRequirementInput } from "../domain/types.js"

export interface ParsedGoalCommand {
  action: "create" | "status" | "contract" | "pause" | "resume" | "clear" | "edit" | "budget" | "history" | "history_prune" | "restore" | "doctor" | "list"
  objective: string
  acceptance: string[]
  constraints: string[]
  checks: string[]
  files: FileRequirementInput[]
  goalIDPrefix?: string
  historyKeep?: number
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

function empty(action: ParsedGoalCommand["action"]): ParsedGoalCommand {
  return { action, objective: "", acceptance: [], constraints: [], checks: [], files: [] }
}

function parseContainsContract(value: string): FileRequirementInput {
  const split = value.indexOf("::")
  if (split <= 0 || split === value.length - 2) throw new Error('--contains expects "path::exact text"')
  return { file: value.slice(0, split), contains: value.slice(split + 2) }
}

function parseLimit(option: string, raw: string | undefined, integer = false): number {
  if (raw === undefined) throw new Error(`${option} expects a non-negative number`)
  const value = integer ? Number(raw) : Number.parseFloat(raw)
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${option} expects a non-negative ${integer ? "integer" : "number"}`)
  }
  return value
}

function parseHistoryKeep(raw: string | undefined): number {
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error("/goal history prune --keep expects a positive integer")
  }
  return value
}

function parseOptionalGoalSelector(list: string[], command: string): ParsedGoalCommand {
  const goalIDPrefix = list[1]?.trim()
  if (list.length > 2) throw new Error(`/goal ${command} accepts at most one goal id prefix`)
  if (goalIDPrefix?.startsWith("--")) throw new Error(`unknown goal option: ${goalIDPrefix}`)
  return {
    ...empty(command === "list" ? "list" : "history"),
    ...(goalIDPrefix ? { goalIDPrefix } : {}),
  }
}

export function parseGoalCommand(input: string): ParsedGoalCommand {
  const list = tokens(input.trim())
  const sub = (list[0] ?? "").toLowerCase()
  if (sub === "doctor") {
    if (list.length !== 1) throw new Error("/goal doctor does not accept arguments")
    return empty("doctor")
  }
  if (sub === "contract") {
    if (list.length !== 1) throw new Error("/goal contract does not accept arguments")
    return empty("contract")
  }
  if (["status", "pause", "resume", "clear"].includes(sub)) {
    return empty(sub as ParsedGoalCommand["action"])
  }
  if (sub === "list") return parseOptionalGoalSelector(list, "list")
  if (sub === "history") {
    if ((list[1] ?? "").toLowerCase() === "prune") {
      if (list.length !== 4 || list[2] !== "--keep") {
        throw new Error("/goal history prune expects --keep <positive-integer>")
      }
      return {
        ...empty("history_prune"),
        historyKeep: parseHistoryKeep(list[3]),
      }
    }
    return parseOptionalGoalSelector(list, "history")
  }
  if (sub === "restore") {
    const goalIDPrefix = list[1]?.trim()
    if (list.length !== 2) throw new Error("/goal restore expects exactly one goal id prefix")
    if (goalIDPrefix?.startsWith("--")) throw new Error(`unknown goal option: ${goalIDPrefix}`)
    return {
      ...empty("restore"),
      ...(goalIDPrefix ? { goalIDPrefix } : {}),
    }
  }

  let action: ParsedGoalCommand["action"] = "create"
  if (sub === "edit" || sub === "budget") {
    action = sub
    list.shift()
  }

  const acceptance: string[] = []
  const constraints: string[] = []
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
    if ((current === "--accept" || current === "--acceptance" || current === "--success") && next) { acceptance.push(next); i += 1; continue }
    if (["--constraint", "--constraints", "--non-goal", "--non-goals"].includes(current) && next) { constraints.push(next); i += 1; continue }
    if (current === "--check" && next) { checks.push(next); i += 1; continue }
    if (current === "--file" && next) { files.push({ file: next }); i += 1; continue }
    if (current === "--contains" && next) { files.push(parseContainsContract(next)); i += 1; continue }
    if (current === "--max-turns") { maxTurns = parseLimit(current, next, true); i += 1; continue }
    if (current === "--max-tokens") { maxTokens = parseLimit(current, next, true); i += 1; continue }
    if (current === "--max-minutes") { maxRuntimeMs = parseLimit(current, next) * 60_000; i += 1; continue }
    if (current === "--max-cost") { maxCost = parseLimit(current, next); i += 1; continue }
    if (current.startsWith("--")) throw new Error(`unknown goal option: ${current}`)
    objective.push(current)
  }

  if (action === "budget" && (objective.length || acceptance.length || constraints.length || checks.length || files.length)) {
    throw new Error("/goal budget accepts only --max-turns, --max-tokens, --max-minutes, and --max-cost")
  }

  const parsed: ParsedGoalCommand = { action, objective: objective.join(" ").trim(), acceptance, constraints, checks, files }
  if (maxTurns !== undefined) parsed.maxTurns = maxTurns
  if (maxTokens !== undefined) parsed.maxTokens = maxTokens
  if (maxRuntimeMs !== undefined) parsed.maxRuntimeMs = maxRuntimeMs
  if (maxCost !== undefined) parsed.maxCost = maxCost
  return parsed
}