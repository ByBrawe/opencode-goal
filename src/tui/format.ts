import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { translateCoreText } from "../i18n.js"

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

function compactNumber(value: number): string {
  const n = Math.max(0, value)
  if (n < 1_000) return Math.round(n).toLocaleString("en-US")
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

function compactDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours < 48) return remainder ? `${hours}h ${remainder}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function age(value: number | undefined, now: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a"
  return `${compactDuration(Math.max(0, now - value))} ago`
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function budgetValue(value: number | undefined, formatter: (value: number) => string): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? formatter(value) : "∞"
}

function validGoal(value: unknown, sessionID: string): value is {
  sessionID: string
  id: string
  objective: string
  status: string
  completionMode?: "verified" | "continuous"
  revision?: number
  createdAt?: number
  updatedAt?: number
  stopReason?: string
  stalledTurns?: number
  requirements: Array<{ required?: boolean; status?: string; verification?: string }>
  usage?: { turns?: number; tokens?: number; cost?: number; runtimeMs?: number }
  budget?: { maxTurns?: number; maxTokens?: number; maxCost?: number; maxRuntimeMs?: number }
  execution?: {
    agent?: string
    model?: { providerID?: string; modelID?: string }
    modelContext?: { contextLimit?: number; lastRequestTokens?: number; observedAt?: number }
  }
  progressNotes?: Array<{ time?: number; summary?: string; next?: string }>
  todoPlan?: {
    goalRevision?: number
    total?: number
    pending?: number
    inProgress?: number
    completed?: number
    cancelled?: number
    observedAt?: number
    items?: Array<{ content?: string; status?: string }>
  }
  pendingContinuation?: boolean
  infrastructureRecovery?: { kind?: string; attempt?: number; nextRetryAt?: number }
  unitRotation?: { chainIndex?: number; currentUnit?: string; handoff?: { phase?: string } }
} {
  if (!value || typeof value !== "object") return false
  const goal = value as any
  return goal.schemaVersion === 1 && goal.sessionID === sessionID && typeof goal.id === "string" && typeof goal.objective === "string" && typeof goal.status === "string"
    && (goal.completionMode === undefined || goal.completionMode === "verified" || goal.completionMode === "continuous")
    && Array.isArray(goal.requirements)
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
    const now = Date.now()
    const required = goal.requirements.filter((item) => item.required !== false)
    const proven = required.filter((item) => item.status === "proven").length
    const checks = required.filter((item) => item.verification === "command")
    const files = required.filter((item) => item.verification === "file")
    const checksProven = checks.filter((item) => item.status === "proven").length
    const filesProven = files.filter((item) => item.status === "proven").length
    const continuous = goal.completionMode === "continuous"
    const revision = Number.isSafeInteger(goal.revision) ? ` · r${goal.revision}` : ""
    lines.push(`${goal.status.toUpperCase()} · ${continuous ? "CONTINUOUS" : "VERIFIED"}${revision}`)
    lines.push(`${goal.id.slice(0, 12)} · ${truncate(goal.objective, 40)}`)

    const turns = finiteNumber(goal.usage?.turns)
    const tokens = finiteNumber(goal.usage?.tokens)
    const cost = finiteNumber(goal.usage?.cost)
    const runtimeMs = finiteNumber(goal.usage?.runtimeMs)
    const createdAt = typeof goal.createdAt === "number" && Number.isFinite(goal.createdAt) ? goal.createdAt : now
    lines.push(`age ${compactDuration(Math.max(0, now - createdAt))} · model runtime ${compactDuration(runtimeMs)}`)
    lines.push(`turns ${compactNumber(turns)}/${budgetValue(goal.budget?.maxTurns, compactNumber)} · tokens ${compactNumber(tokens)}/${budgetValue(goal.budget?.maxTokens, compactNumber)}`)
    lines.push(`cost ${cost.toFixed(4)}/${budgetValue(goal.budget?.maxCost, (value) => value.toFixed(4))} · runtime cap ${budgetValue(goal.budget?.maxRuntimeMs, compactDuration)}`)

    const provider = typeof goal.execution?.model?.providerID === "string" ? goal.execution.model.providerID : undefined
    const modelID = typeof goal.execution?.model?.modelID === "string" ? goal.execution.model.modelID : undefined
    const model = provider && modelID ? `${provider}/${modelID}` : modelID ?? provider ?? "unbound"
    const lastRequestTokens = typeof goal.execution?.modelContext?.lastRequestTokens === "number" && Number.isFinite(goal.execution.modelContext.lastRequestTokens)
      ? goal.execution.modelContext.lastRequestTokens
      : undefined
    const contextLimit = typeof goal.execution?.modelContext?.contextLimit === "number" && Number.isFinite(goal.execution.modelContext.contextLimit)
      ? goal.execution.modelContext.contextLimit
      : undefined
    const context = lastRequestTokens !== undefined || contextLimit !== undefined
      ? ` · context ${compactNumber(lastRequestTokens ?? 0)}/${contextLimit ? compactNumber(contextLimit) : "?"}`
      : ""
    lines.push(`model ${truncate(model, 44)}${context}`)

    const verifyParts = [`req ${proven}/${required.length}`]
    if (checks.length) verifyParts.push(`checks ${checksProven}/${checks.length}`)
    if (files.length) verifyParts.push(`files ${filesProven}/${files.length}`)
    lines.push(`progress ${continuous ? "continuous" : verifyParts.join(" · ")}`)
    if (continuous && required.length) lines.push(`verification ${verifyParts.join(" · ")}`)

    const todo = goal.todoPlan
    if (todo && typeof todo.total === "number") {
      const fresh = todo.goalRevision === goal.revision ? "" : " STALE"
      lines.push(`plan${fresh} ${todo.completed ?? 0}/${todo.total} done · ${todo.inProgress ?? 0} active · ${todo.pending ?? 0} pending`)
      const current = todo.items?.find((item) => item.status === "in_progress")
      if (current?.content) lines.push(`→ ${truncate(current.content, 50)}`)
    } else {
      lines.push("plan not observed")
    }

    const hostProgress = [...(goal.progressNotes ?? [])].reverse().find((item) => typeof item.summary === "string" && item.summary.startsWith("[host:"))
    lines.push(`host progress ${age(hostProgress?.time, now)} · state update ${age(goal.updatedAt, now)}`)

    let activity = goal.status.toUpperCase()
    if (goal.infrastructureRecovery?.kind) {
      activity = `recovery ${goal.infrastructureRecovery.kind} #${goal.infrastructureRecovery.attempt ?? "?"}`
    } else if (goal.unitRotation?.handoff?.phase) {
      activity = `handoff ${goal.unitRotation.handoff.phase}`
    } else if (goal.pendingContinuation) {
      activity = "continuation pending"
    } else if (goal.todoPlan?.items?.some((item) => item.status === "in_progress")) {
      activity = "todo in progress"
    } else if (goal.status === "active") {
      activity = "active; no live phase persisted"
    }
    lines.push(`current ${activity}`)
    if (goal.status !== "active" && goal.stopReason) lines.push(`stop ${truncate(goal.stopReason, 56)}`)
    if ((goal.stalledTurns ?? 0) > 0) lines.push(`stall guard ${goal.stalledTurns} no-progress turn(s)`)
  }

  if (sequenceRead.state === "invalid" || (sequenceRead.state === "valid" && !sequence)) {
    lines.push("! Queue storage unavailable")
    return translateCoreText(lines.join("\n"))
  }

  const items = sequence?.items ?? []
  lines.push(`Queue · ${items.length}`)
  for (const [index, item] of items.slice(0, 3).entries()) {
    lines.push(`${index + 1}. ${item.activating ? "↻ " : ""}${truncate(item.objective, 42)}`)
  }
  if (items.length > 3) lines.push(`… +${items.length - 3} more`)
  return translateCoreText(lines.join("\n"))
}
