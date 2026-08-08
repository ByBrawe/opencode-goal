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
  revision: number
  status: GoalStatus
  requirements: GoalRequirement[]
  evidence: EvidenceRecord[]
  checks: string[]
  execution?: GoalExecutionContext
  usage: GoalUsage
  budget: GoalBudget
  progressRevision: number
  observedProgressRevision: number
  /** Stable host-observed change fingerprints for this goal revision. */
  progressFingerprints?: string[]
  stalledTurns: number
  blockerAudit?: BlockerAudit
  progressNotes: ProgressNote[]
  completionSummary?: string
  stopReason?: string
  createdAt: number
  updatedAt: number
}

export interface CompletionAudit {
  ok: boolean
  reasons: string[]
  missingRequirementIDs: string[]
}
