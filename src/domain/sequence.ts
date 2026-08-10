import type { FileRequirementInput, GoalBudget, GoalState } from "./types.js"

export interface QueuedGoalSpec {
  id: string
  objective: string
  acceptance: string[]
  constraints: string[]
  checks: string[]
  files: FileRequirementInput[]
  budget: Partial<GoalBudget>
  createdAt: number
  activating?: boolean
}

export interface GoalSequenceState {
  schemaVersion: 1
  sessionID: string
  generation: number
  items: QueuedGoalSpec[]
  updatedAt: number
}

export interface QueueGoalInput {
  objective: string
  acceptance?: string[]
  constraints?: string[]
  checks?: string[]
  files?: FileRequirementInput[]
  budget?: Partial<GoalBudget>
  now?: number
}

export type GoalSequenceSelectResult =
  | { ok: true; item: QueuedGoalSpec; sequence: GoalSequenceState }
  | { ok: false; reason: "not_found" | "ambiguous" | "activating"; matches: QueuedGoalSpec[] }

export type GoalSequenceMoveResult =
  | { ok: true; item: QueuedGoalSpec; position: number; sequence: GoalSequenceState }
  | { ok: false; reason: "not_found" | "ambiguous" | "activating" | "position"; matches: QueuedGoalSpec[] }

export type GoalSequenceClearResult =
  | { ok: true; removed: QueuedGoalSpec[]; sequence: GoalSequenceState }
  | { ok: false; reason: "activating"; matches: QueuedGoalSpec[] }

export type GoalSequencePromotionResult =
  | { ok: true; goal: GoalState; queued: QueuedGoalSpec; recovered: boolean; remaining: number }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "live_unfinished"; current: GoalState }
