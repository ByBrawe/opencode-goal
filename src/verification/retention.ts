import type { EvidenceRecord, GoalState } from "../domain/types.js"

export const EVIDENCE_RETENTION_LIMIT = 500

function verificationKey(item: EvidenceRecord): string {
  return `${item.kind}\u0000${item.source ?? ""}\u0000${[...item.requirementIDs].sort().join(",")}`
}

/**
 * Evidence retention is a bounded cache, not an authority boundary. The normal
 * target remains 500 records, but correctness-critical records are pinned:
 *
 * - current-revision trusted evidence still referenced by a requirement; and
 * - the latest current-revision host/verifier result for each verification key.
 *
 * If the pinned set itself exceeds the target, retain every pin rather than
 * silently weakening completion auditing. In the common case, fill the
 * remaining slots with the newest unpinned records while preserving order.
 */
export function retainEvidenceRecords(
  goal: GoalState,
  evidence: EvidenceRecord[],
  limit = EVIDENCE_RETENTION_LIMIT,
): EvidenceRecord[] {
  const boundedLimit = Math.max(0, Math.floor(limit))
  if (evidence.length <= boundedLimit) return evidence

  const byID = new Map(evidence.map((item) => [item.id, item]))
  const pinned = new Set<string>()

  for (const requirement of goal.requirements) {
    for (const id of requirement.evidenceIDs) {
      const item = byID.get(id)
      if (!item) continue
      if (item.goalRevision !== goal.revision || item.trust === "agent") continue
      pinned.add(item.id)
    }
  }

  const latestVerification = new Map<string, EvidenceRecord>()
  for (const item of evidence) {
    if (item.goalRevision !== goal.revision) continue
    if (item.trust !== "host" && item.trust !== "verifier") continue
    if (item.kind === "agent_note") continue
    const key = verificationKey(item)
    const previous = latestVerification.get(key)
    if (!previous || item.createdAt >= previous.createdAt) latestVerification.set(key, item)
  }
  for (const item of latestVerification.values()) pinned.add(item.id)

  if (pinned.size >= boundedLimit) {
    return evidence.filter((item) => pinned.has(item.id))
  }

  const remaining = boundedLimit - pinned.size
  const recentUnpinned = evidence
    .filter((item) => !pinned.has(item.id))
    .slice(-remaining)
  const keep = new Set([...pinned, ...recentUnpinned.map((item) => item.id)])
  return evidence.filter((item) => keep.has(item.id))
}
