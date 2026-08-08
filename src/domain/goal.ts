import { randomUUID } from "node:crypto"
import type { FileRequirementInput, GoalBudget, GoalExecutionContext, GoalRequirement, GoalState, VerificationKind } from "./types.js"

const DEFAULT_BUDGET: GoalBudget = {
  maxTurns: 30,
  maxTokens: 400_000,
  maxCost: 0,
  maxRuntimeMs: 60 * 60_000,
}

function requirement(input: {
  text: string
  verification: VerificationKind
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
    ...(input.command ? { command: input.command } : {}),
    ...(input.file ? { file: input.file } : {}),
    ...(input.contains ? { contains: input.contains } : {}),
    updatedAt: now,
  }
}

export function createGoal(input: {
  sessionID: string
  objective: string
  acceptance?: string[]
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
  const checks = (input.checks ?? []).map((item) => item.trim()).filter(Boolean)
  const files = (input.files ?? []).filter((item) => item.file.trim())
  const requirements: GoalRequirement[] = []

  if (acceptance.length === 0 && checks.length === 0 && files.length === 0) {
    requirements.push(requirement({ text: `Objective achieved: ${objective}`, verification: "semantic" }))
  }
  for (const item of acceptance) requirements.push(requirement({ text: item, verification: "semantic" }))
  for (const command of checks) requirements.push(requirement({ text: `Verification command passes: ${command}`, verification: "command", command }))
  for (const item of files) {
    const file = item.file.trim()
    const contains = item.contains?.trim()
    requirements.push(requirement({
      text: contains ? `File ${file} contains: ${contains}` : `File exists: ${file}`,
      verification: "file",
      file,
      ...(contains ? { contains } : {}),
    }))
  }

  return {
    schemaVersion: 1,
    id: randomUUID(),
    sessionID: input.sessionID,
    objective,
    revision: 1,
    status: "active",
    requirements,
    evidence: [],
    checks,
    ...(input.execution ? { execution: input.execution } : {}),
    usage: { turns: 0, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: [] },
    budget: { ...DEFAULT_BUDGET, ...input.budget },
    progressRevision: 0,
    observedProgressRevision: 0,
    stalledTurns: 0,
    progressNotes: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function editGoal(goal: GoalState, input: {
  objective: string
  acceptance?: string[]
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
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
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
    progressRevision: goal.progressRevision + 1,
    observedProgressRevision: goal.progressRevision + 1,
    progressNotes: goal.progressNotes,
    createdAt: goal.createdAt,
  }
}

export function pauseGoal(goal: GoalState, reason = "paused by user", now = Date.now()): GoalState {
  if (goal.status === "completed") return goal
  return { ...goal, status: "paused", stopReason: reason, updatedAt: now }
}

export function resumeGoal(goal: GoalState, now = Date.now()): GoalState {
  if (goal.status === "completed") return goal
  const { blockerAudit: _blocker, stopReason: _reason, ...rest } = goal
  return { ...rest, status: "active", stalledTurns: 0, observedProgressRevision: goal.progressRevision, updatedAt: now }
}
