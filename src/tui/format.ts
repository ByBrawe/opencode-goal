import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

function shard(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

type ReadResult = { state: "missing" } | { state: "invalid" } | { state: "valid"; value: unknown }

function safeReadJson(root: string, file: string): ReadResult {
  try {
    const base = path.resolve(root)
    const target = path.resolve(file)
    if (!isWithin(base, target)) return { state: "invalid" }
    const baseReal = realpathSync(base)
    const relative = path.relative(base, target)
    let current = base
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      let stat
      try {
        stat = lstatSync(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break
        return { state: "invalid" }
      }
      if (stat.isSymbolicLink()) return { state: "invalid" }
      const real = realpathSync(current)
      if (!isWithin(baseReal, real)) return { state: "invalid" }
    }
    return { state: "valid", value: JSON.parse(readFileSync(target, "utf8")) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" }
    return { state: "invalid" }
  }
}

function truncate(value: string, max = 48): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

function validGoal(value: unknown, sessionID: string): value is {
  sessionID: string
  id: string
  objective: string
  status: string
  requirements: Array<{ required?: boolean; status?: string }>
  usage?: { turns?: number; tokens?: number }
  budget?: { maxTurns?: number; maxTokens?: number }
} {
  if (!value || typeof value !== "object") return false
  const goal = value as any
  return goal.schemaVersion === 1 && goal.sessionID === sessionID && typeof goal.id === "string" && typeof goal.objective === "string" && typeof goal.status === "string" && Array.isArray(goal.requirements)
}

function validSequence(value: unknown, sessionID: string): value is { sessionID: string; items: Array<{ id: string; objective: string; activating?: boolean }> } {
  if (!value || typeof value !== "object") return false
  const sequence = value as any
  return sequence.schemaVersion === 1 && sequence.sessionID === sessionID && Array.isArray(sequence.items)
    && sequence.items.every((item: any) => item && typeof item.id === "string" && typeof item.objective === "string" && (item.activating === undefined || typeof item.activating === "boolean"))
}

export function formatGoalSidebar(root: string, sessionID: string): string {
  const key = shard(sessionID)
  const goalRead = safeReadJson(root, path.join(root, ".opencode", "goals", `${key}.json`))
  const sequenceRead = safeReadJson(root, path.join(root, ".opencode", "goal-sequences", `${key}.json`))
  const goal = goalRead.state === "valid" && validGoal(goalRead.value, sessionID) ? goalRead.value : null
  const sequence = sequenceRead.state === "valid" && validSequence(sequenceRead.value, sessionID) ? sequenceRead.value : null

  const lines = ["OpenCode Goals"]
  if (goalRead.state === "invalid" || (goalRead.state === "valid" && !goal)) {
    lines.push("! Goal storage unavailable")
  } else if (!goal) {
    lines.push("No live Goal")
  } else {
    const required = goal.requirements.filter((item) => item.required !== false)
    const proven = required.filter((item) => item.status === "proven").length
    lines.push(`${goal.status.toUpperCase()} · ${proven}/${required.length} proven`)
    lines.push(truncate(goal.objective))
    const turns = goal.usage?.turns ?? 0
    const maxTurns = goal.budget?.maxTurns || "∞"
    const tokens = goal.usage?.tokens ?? 0
    const maxTokens = goal.budget?.maxTokens || "∞"
    lines.push(`turns ${turns}/${maxTurns} · tokens ${tokens}/${maxTokens}`)
  }

  if (sequenceRead.state === "invalid" || (sequenceRead.state === "valid" && !sequence)) {
    lines.push("! Queue storage unavailable")
    return lines.join("\n")
  }

  const items = sequence?.items ?? []
  lines.push(`Queue · ${items.length}`)
  for (const [index, item] of items.slice(0, 3).entries()) {
    lines.push(`${index + 1}. ${item.activating ? "↻ " : ""}${truncate(item.objective, 42)}`)
  }
  if (items.length > 3) lines.push(`… +${items.length - 3} more`)
  return lines.join("\n")
}
