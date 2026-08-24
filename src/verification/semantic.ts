import { randomUUID } from "node:crypto"
import type { EvidenceRecord, GoalState, RequirementStatus } from "../domain/types.js"
import { retainEvidenceRecords } from "./retention.js"

export type SemanticVerdict = "proven" | "failed" | "unknown"

export interface SemanticEvidenceRef {
  path: string
  quote: string
  sha256?: string
}

export interface SemanticRequirementResult {
  requirementID: string
  verdict: SemanticVerdict
  reason: string
  evidence: SemanticEvidenceRef[]
  hostEvidenceIDs: string[]
}

function statusForVerdict(verdict: SemanticVerdict): RequirementStatus {
  if (verdict === "proven") return "proven"
  if (verdict === "failed") return "failed"
  return "unknown"
}

export function applySemanticVerifierResults(
  goal: GoalState,
  results: SemanticRequirementResult[],
  now = Date.now(),
): GoalState {
  const expected = new Set(goal.requirements.filter((item) => item.required && item.verification === "semantic").map((item) => item.id))
  const seen = new Set<string>()
  let next = goal

  for (const result of results) {
    if (!expected.has(result.requirementID)) throw new Error(`verifier returned unexpected requirement: ${result.requirementID}`)
    if (seen.has(result.requirementID)) throw new Error(`verifier returned duplicate requirement: ${result.requirementID}`)
    seen.add(result.requirementID)
    const reason = result.reason.trim()
    const evidenceItems = result.evidence
      .map((item) => ({ path: item.path.trim(), quote: item.quote.trim(), ...(item.sha256 ? { sha256: item.sha256 } : {}) }))
      .filter((item) => item.path && item.quote)
    const hostEvidenceIDs = [...new Set(result.hostEvidenceIDs.map((item) => item.trim()).filter(Boolean))]
    if (!reason) throw new Error("verifier result reason must not be empty")
    if (result.verdict === "proven" && evidenceItems.length === 0 && hostEvidenceIDs.length === 0) {
      throw new Error("proven semantic requirement requires current corroborated evidence")
    }
    const refs = [
      ...evidenceItems.map((item) => `${item.path}: ${item.quote}`),
      ...hostEvidenceIDs.map((id) => `host:${id}`),
    ]
    const evidence: EvidenceRecord = {
      id: randomUUID(),
      kind: evidenceItems.length > 0 ? "file" : "runtime",
      trust: "verifier",
      summary: `Independent verifier: ${result.verdict}. ${reason}${refs.length ? ` Evidence: ${refs.join("; ")}` : ""}`,
      createdAt: now,
      goalRevision: goal.revision,
      requirementIDs: [result.requirementID],
      source: "semantic-verifier",
      ...(result.verdict === "unknown" ? {} : { passed: result.verdict === "proven" }),
      metadata: { verdict: result.verdict, evidenceCount: refs.length },
    }
    const candidate: GoalState = {
      ...next,
      evidence: [...next.evidence, evidence],
      requirements: next.requirements.map((item) => item.id === result.requirementID
        ? { ...item, status: statusForVerdict(result.verdict), evidenceIDs: [evidence.id], updatedAt: now }
        : item),
      progressRevision: result.verdict === "proven" ? next.progressRevision + 1 : next.progressRevision,
      updatedAt: now,
    }
    next = { ...candidate, evidence: retainEvidenceRecords(candidate, candidate.evidence) }
  }

  for (const id of expected) {
    if (!seen.has(id)) throw new Error(`verifier omitted semantic requirement: ${id}`)
  }
  return next
}
