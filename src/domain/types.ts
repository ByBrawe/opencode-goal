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
export type GoalInfrastructureRecoveryKind = "semantic_verifier" | "continuation_dispatch" | "provider_retry"

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
 * A recoverable host/provider failure. This is deliberately not a Goal stop
 * state: the task contract remains active while the plugin waits for a bounded
 * retry window. Persisting it lets process restarts preserve the recovery
 * deadline instead of turning a temporary outage into a manual /goal resume.
 */
export interface GoalInfrastructureRecovery {
  kind: GoalInfrastructureRecoveryKind
  reason: string
  attempt: number
  startedAt: number
  nextRetryAt: number
}

/**
 * One durable item from OpenCode's native Todo plan.
 *
 * `key` is Goal-owned and deterministic from the item's planning identity; it
 * is not completion evidence and does not replace OpenCode's optional native
 * Todo id. Keeping the exact item text/status/order lets restart/compaction
 * recovery reconstruct the last observed work plan without making Goal a
 * second Todo authority.
 */
export interface GoalTodoPlanItem {
  key: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority?: string
  nativeID?: string
  order: number
}

/**
 * Advisory telemetry for OpenCode's native session Todo plan.
 *
 * The Todo list is owned by OpenCode and remains execution-planning state, not
 * Goal completion evidence. Aggregate counts/digest are retained for cheap
 * gating/status, while `items` keeps a revision-bound durable snapshot for
 * restart/compaction reconciliation. Older schema-v1 snapshots may omit items.
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
  items?: GoalTodoPlanItem[]
}

export interface FileRequirementInput {
  file: string
  contains?: string
}

/**
 * OpenCode model-window telemetry for the currently bound execution model.
 * This is intentionally separate from GoalUsage/GoalBudget: Goal token usage is
 * cumulative across the whole Goal, while these values describe one model's
 * context limits and the most recently observed request size.
 */
export interface GoalModelContext {
  contextLimit?: number
  inputLimit?: number
  outputLimit?: number
  lastRequestTokens?: number
  /** Input-side request tokens (input + cache), kept separate from generated output. */
  lastInputTokens?: number
  autoCompaction?: boolean
  compactionReserved?: number
  observedAt: number
}

export interface GoalExecutionContext {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  modelContext?: GoalModelContext
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
  /** One-shot accounting exemption for a turn consumed only by infrastructure recovery/verification. */
  skipNextStallCheck?: boolean
  /** Persisted retry state for transient verifier/provider/dispatch failures. */
  infrastructureRecovery?: GoalInfrastructureRecovery | undefined
  /** Native OpenCode Todo-plan telemetry/manifest. Advisory only; never completion evidence. */
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
