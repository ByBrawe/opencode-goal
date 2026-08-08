import type { GoalState } from "../domain/types.js"
import { proveRequirementsFromEvidence, recordFileEvidence } from "./evidence.js"

export async function verifyDeclaredFiles(goal: GoalState, root: string): Promise<GoalState> {
  let next = goal
  for (const requirement of next.requirements.filter((item) => item.verification === "file" && item.file)) {
    const checked = await recordFileEvidence(next, { root, requirementID: requirement.id })
    next = checked.goal
    if (checked.evidence.passed) {
      next = proveRequirementsFromEvidence(next, checked.evidence.id)
    } else {
      const now = checked.evidence.createdAt
      next = {
        ...next,
        requirements: next.requirements.map((item) => item.id === requirement.id ? { ...item, status: "failed" as const, updatedAt: now } : item),
        updatedAt: now,
      }
    }
  }
  return next
}
