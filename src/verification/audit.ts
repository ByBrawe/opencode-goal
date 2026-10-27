import type { CompletionAudit, EvidenceRecord, GoalState } from "../domain/types.js"
import { todoPlanIsCurrent } from "../runtime/todo-plan.js"

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
  if ((goal.completionMode ?? "verified") === "continuous") {
    return {
      ok: false,
      reasons: ["continuous Goal mode disables automatic completion; use /goal edit <objective> --verified to re-enable verified completion, or /goal pause / /goal clear to stop the run"],
      missingRequirementIDs: [],
    }
  }

  const reasons: string[] = []
  const missingRequirementIDs: string[] = []

  if (!["active", "paused", "waiting_user", "blocked", "budget_limited", "usage_limited"].includes(goal.status)) {
    reasons.push(`goal status ${goal.status} cannot enter completion audit`)
  }

  if (todoPlanIsCurrent(goal) && goal.todoPlan && (goal.todoPlan.pending > 0 || goal.todoPlan.inProgress > 0)) {
    reasons.push(`current native Todo plan still has unfinished work: ${goal.todoPlan.pending} pending, ${goal.todoPlan.inProgress} in progress`)
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

/**
 * Identity of the completion-relevant Goal snapshot.
 *
 * A verifier/check result is only valid for the exact requirements, evidence,
 * progress, revision turn baseline and current Todo plan it was computed from.
 * Notes, timestamps and non-turn usage telemetry are intentionally excluded so
 * unrelated writers can still merge without forcing a verification replay.
 */
export function completionSnapshotIdentity(goal: GoalState): string {
  return JSON.stringify({
    id: goal.id,
    revision: goal.revision,
    status: goal.status,
    completionMode: goal.completionMode ?? "verified",
    requirements: goal.requirements.map((item) => ({
      id: item.id,
      text: item.text,
      required: item.required,
      status: item.status,
      evidenceIDs: item.evidenceIDs,
      verification: item.verification,
      command: item.command ?? null,
      file: item.file ?? null,
      contains: item.contains ?? null,
    })),
    evidence: goal.evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      trust: item.trust,
      goalRevision: item.goalRevision,
      requirementIDs: item.requirementIDs,
      source: item.source ?? null,
      passed: item.passed ?? null,
      metadata: item.metadata ?? null,
    })),
    checks: goal.checks,
    usageTurns: goal.usage.turns,
    revisionTurnBaseline: goal.revisionTurnBaseline ?? 0,
    progressRevision: goal.progressRevision,
    progressFingerprints: goal.progressFingerprints ?? [],
    todoPlan: goal.todoPlan
      ? {
          goalRevision: goal.todoPlan.goalRevision,
          digest: goal.todoPlan.digest,
          total: goal.todoPlan.total,
          pending: goal.todoPlan.pending,
          inProgress: goal.todoPlan.inProgress,
          completed: goal.todoPlan.completed,
          cancelled: goal.todoPlan.cancelled,
        }
      : null,
  })
}
