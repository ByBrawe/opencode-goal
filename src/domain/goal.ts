import { randomUUID } from "node:crypto"
import type { FileRequirementInput, GoalBudget, GoalExecutionContext, GoalRequirement, GoalRequirementSource, GoalState, VerificationKind } from "./types.js"

const DEFAULT_BUDGET: GoalBudget = {
  maxTurns: 30,
  maxTokens: 400_000,
  maxCost: 0,
  maxRuntimeMs: 60 * 60_000,
}

function requirement(input: {
  text: string
  verification: VerificationKind
  source: GoalRequirementSource
  command?: string
  file?: string
  contains?: string
}): GoalRequirement {
  const now = Date.now()
  return {
    id: randomUUID(),
    text: input.text.trim(),
    required: true,
    status: "pending",
    evidenceIDs: [],
    verification: input.verification,
    source: input.source,
    ...(input.command ? { command: input.command } : {}),
    ...(input.file ? { file: input.file } : {}),
    ...(input.contains ? { contains: input.contains } : {}),
    updatedAt: now,
  }
}

function existingAcceptance(goal: GoalState): string[] {
  const semantic = goal.requirements.filter((item) => item.verification === "semantic")
  return semantic
    .filter((item, index) => item.source === "acceptance" || (!item.source && index > 0))
    .map((item) => item.text)
}

function existingConstraints(goal: GoalState): string[] {
  if (Array.isArray(goal.constraints)) return [...goal.constraints]
  return goal.requirements
    .filter((item) => item.source === "constraint")
    .map((item) => item.text.replace(/^Constraint preserved:\s*/i, "").trim())
    .filter(Boolean)
}

export function createGoal(input: {
  sessionID: string
  objective: string
  acceptance?: string[]
  constraints?: string[]
  checks?: string[]
  files?: FileRequirementInput[]
  execution?: GoalExecutionContext
  budget?: Partial<GoalBudget>
  now?: number
}): GoalState {
  const now = input.now ?? Date.now()
  const objective = input.objective.trim()
  if (!objective) throw new Error("goal objective must not be empty")
  const acceptance = (input.acceptance ?? []).map((item) => item.trim()).filter(Boolean)
  const constraints = (input.constraints ?? []).map((item) => item.trim()).filter(Boolean)
  const checks = (input.checks ?? []).map((item) => item.trim()).filter(Boolean)
  const files = (input.files ?? []).filter((item) => item.file.trim())
  const requirements: GoalRequirement[] = [
    requirement({ text: `Objective achieved: ${objective}`, verification: "semantic", source: "objective" }),
  ]

  for (const item of acceptance) requirements.push(requirement({ text: item, verification: "semantic", source: "acceptance" }))
  for (const item of constraints) requirements.push(requirement({ text: `Constraint preserved: ${item}`, verification: "semantic", source: "constraint" }))
  for (const command of checks) requirements.push(requirement({ text: `Verification command passes: ${command}`, verification: "command", source: "check", command }))
  for (const item of files) {
    const file = item.file.trim()
    const contains = item.contains?.trim()
    requirements.push(requirement({
      text: contains ? `File ${file} contains: ${contains}` : `File exists: ${file}`,
      verification: "file",
      source: "file",
      file,
      ...(contains ? { contains } : {}),
    }))
  }

  return {
    schemaVersion: 1,
    id: randomUUID(),
    sessionID: input.sessionID,
    objective,
    constraints,
    revision: 1,
    status: "active",
    requirements,
    evidence: [],
    checks,
    ...(input.execution ? { execution: input.execution } : {}),
    usage: { turns: 0, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: [] },
    revisionTurnBaseline: 0,
    budget: { ...DEFAULT_BUDGET, ...input.budget },
    progressRevision: 0,
    observedProgressRevision: 0,
    progressFingerprints: [],
    stalledTurns: 0,
    progressNotes: [],
    storageGeneration: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function editGoal(goal: GoalState, input: {
  objective: string
  acceptance?: string[]
  constraints?: string[]
  checks?: string[]
  files?: FileRequirementInput[]
  execution?: GoalExecutionContext
  now?: number
}): GoalState {
  const existingFiles = goal.requirements
    .filter((item) => item.verification === "file" && item.file)
    .map((item) => ({ file: item.file!, ...(item.contains ? { contains: item.contains } : {}) }))
  const next = createGoal({
    sessionID: goal.sessionID,
    objective: input.objective,
    acceptance: input.acceptance ?? existingAcceptance(goal),
    constraints: input.constraints ?? existingConstraints(goal),
    checks: input.checks ?? goal.checks,
    files: input.files ?? existingFiles,
    ...((input.execution ?? goal.execution) ? { execution: input.execution ?? goal.execution } : {}),
    budget: goal.budget,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return {
    ...next,
    id: goal.id,
    revision: goal.revision + 1,
    evidence: goal.evidence,
    usage: goal.usage,
    revisionTurnBaseline: goal.usage.turns,
    progressRevision: goal.progressRevision + 1,
    observedProgressRevision: goal.progressRevision + 1,
    progressFingerprints: [],
    progressNotes: goal.progressNotes,
    ...(goal.todoPlan ? { todoPlan: goal.todoPlan } : {}),
    storageGeneration: goal.storageGeneration ?? 0,
    createdAt: goal.createdAt,
  }
}

/** Apply command-line constraint flags inside the revision already created by /goal create or /goal edit. */
export function replaceGoalConstraints(goal: GoalState, constraints: string[], now = Date.now()): GoalState {
  const normalized = constraints.map((item) => item.trim()).filter(Boolean)
  const retained = goal.requirements.filter((item) => item.source !== "constraint")
  const constraintRequirements = normalized.map((item) => requirement({
    text: `Constraint preserved: ${item}`,
    verification: "semantic",
    source: "constraint",
  }))
  return {
    ...goal,
    constraints: normalized,
    requirements: [...retained, ...constraintRequirements],
    updatedAt: now,
  }
}

export function pauseGoal(goal: GoalState, reason = "paused by user", now = Date.now()): GoalState {
  if (goal.status === "completed") return goal
  return { ...goal, status: "paused", stopReason: reason, updatedAt: now }
}

export function resumeGoal(goal: GoalState, now = Date.now()): GoalState {
  if (goal.status === "completed") return goal
  const { blockerAudit: _blocker, stopReason: _reason, pendingContinuation: _pendingContinuation, ...rest } = goal
  return { ...rest, status: "active", stalledTurns: 0, observedProgressRevision: goal.progressRevision, updatedAt: now }
}
