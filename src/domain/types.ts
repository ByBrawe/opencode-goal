export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "usage_limited"
  | "completed"

export type RequirementStatus = "pending" | "proven" | "failed" | "unknown" | "blocked"
export type EvidenceKind = "command" | "file" | "diff" | "artifact" | "runtime" | "external" | "manual" | "agent_note"
export type EvidenceTrust = "host" | "verifier" | "user" | "agent"
export type VerificationKind = "semantic" | "command" | "file"
export type GoalRequirementSource = "objective" | "acceptance" | "constraint" | "check" | "file"

export interface EvidenceRecord {
  id: string
  kind: EvidenceKind
  trust: EvidenceTrust
  summary: string
  createdAt: number
  goalRevision: number
  requirementIDs: string[]
  source?: string
  passed?: boolean
  metadata?: Record<string, string | number | boolean | null>
}

export interface GoalRequirement {
  id: string
  text: string
  required: boolean
  status: RequirementStatus
  evidenceIDs: string[]
  verification: VerificationKind
  /** Structured Goal Contract origin. Older schema-v1 snapshots may omit it. */
  source?: GoalRequirementSource
  command?: string
  file?: string
  contains?: string
  updatedAt: number
}

export interface GoalUsage {
  turns: number
  tokens: number
  cost: number
  runtimeMs: number
  seenMessageIDs: string[]
}

export interface GoalBudget {
  maxTurns: number
  maxTokens: number
  maxCost: number
  maxRuntimeMs: number
}

export interface BlockerAudit {
  fingerprint: string
  consecutiveTurns: number
  lastTurnID: string
  reason: string
  needed: string
}

export interface ProgressNote {
  time: number
  summary: string
  next: string
}

/**
 * Advisory telemetry for OpenCode's native session Todo plan.
 *
 * The Todo list is owned by OpenCode and remains execution-planning state, not
 * Goal completion evidence. Only aggregate counts/digest are persisted here so
 * a Goal can tell whether the native plan was observed for the current revision
 * without duplicating the Todo database inside Goal storage.
 */
export interface GoalTodoPlan {
  goalRevision: number
  digest: string
  total: number
  pending: number
  inProgress: number
  completed: number
  cancelled: number
  observedAt: number
}

export interface FileRequirementInput {
  file: string
  contains?: string
}

export interface GoalExecutionContext {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

export interface GoalState {
  schemaVersion: 1
  id: string
  sessionID: string
  objective: string
  /** Explicit Goal Contract boundaries/non-goals. Older schema-v1 snapshots may omit this field. */
  constraints?: string[]
  revision: number
  status: GoalStatus
  requirements: GoalRequirement[]
  evidence: EvidenceRecord[]
  checks: string[]
  execution?: GoalExecutionContext
  usage: GoalUsage
  /** Completed-turn counter captured when the current revision started. Older snapshots default to 0. */
  revisionTurnBaseline?: number
  budget: GoalBudget
  progressRevision: number
  observedProgressRevision: number
  /** Stable host-observed change fingerprints for this goal revision. */
  progressFingerprints?: string[]
  stalledTurns: number
  /** One-shot host marker: the Goal was activated at an idle boundary and still needs its first continuation dispatch. */
  pendingContinuation?: boolean
  /** Native OpenCode Todo-plan telemetry. Advisory only; never completion evidence. */
  todoPlan?: GoalTodoPlan
  blockerAudit?: BlockerAudit
  progressNotes: ProgressNote[]
  completionSummary?: string
  stopReason?: string
  /** Optimistic persistence generation. Older schema-v1 snapshots may omit it and are treated as generation 0. */
  storageGeneration?: number
  createdAt: number
  updatedAt: number
}

export interface CompletionAudit {
  ok: boolean
  reasons: string[]
  missingRequirementIDs: string[]
}
