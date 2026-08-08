import type { CompletionAudit, EvidenceRecord, GoalState } from "../domain/types.js"

function latestVerificationEvidence(goal: GoalState): EvidenceRecord[] {
  const latest = new Map<string, EvidenceRecord>()
  for (const item of goal.evidence) {
    if (item.goalRevision !== goal.revision || !["host", "verifier"].includes(item.trust) || item.kind === "agent_note") continue
    const key = `${item.kind}\u0000${item.source ?? ""}\u0000${[...item.requirementIDs].sort().join(",")}`
    const previous = latest.get(key)
    if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item)
  }
  return [...latest.values()]
}

export function auditCompletion(goal: GoalState): CompletionAudit {
  const reasons: string[] = []
  const missingRequirementIDs: string[] = []

  if (!["active", "paused", "blocked", "budget_limited", "usage_limited"].includes(goal.status)) {
    reasons.push(`goal status ${goal.status} cannot enter completion audit`)
  }

  for (const requirement of goal.requirements.filter((item) => item.required)) {
    if (requirement.status !== "proven") {
      missingRequirementIDs.push(requirement.id)
      reasons.push(`requirement is not proven: ${requirement.text}`)
      continue
    }
    const currentEvidence = requirement.evidenceIDs
      .map((id) => goal.evidence.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .filter((item) => item.goalRevision === goal.revision && item.trust !== "agent" && item.passed !== false)
    if (currentEvidence.length === 0) {
      missingRequirementIDs.push(requirement.id)
      reasons.push(`requirement has no current trusted evidence: ${requirement.text}`)
    }
  }

  const currentFailures = latestVerificationEvidence(goal).filter((item) => item.passed === false)
  if (currentFailures.length > 0) reasons.push(`${currentFailures.length} current verification result(s) are failing`)

  return { ok: reasons.length === 0, reasons, missingRequirementIDs: [...new Set(missingRequirementIDs)] }
}

export function completeGoal(goal: GoalState, summary: string, now = Date.now()): { goal: GoalState; audit: CompletionAudit } {
  const audit = auditCompletion(goal)
  if (!audit.ok) return { goal, audit }
  return {
    goal: { ...goal, status: "completed", completionSummary: summary.trim() || "Goal completed with verified evidence.", updatedAt: now },
    audit,
  }
}
