import type { EvidenceRecord, GoalState } from "../domain/types.js"
import type { SemanticRequirementResult } from "./semantic.js"
import { explicitFileTargets, requestsDeletion, needsConcreteDeliverable } from "./semantic-targets.js"

export interface ProcessTurnExpectation {
  turns: number
  mode: "exactly" | "atLeast"
  requireMutationPerTurn: boolean
}

const ENGLISH_PER_TURN = /\b(?:in|on|during)\s+each\s+(?:goal\s+)?turn\b|\beach\s+(?:goal\s+)?turn\b/i
const TURKISH_PER_TURN = /\bher\s+(?:goal\s+)?tur(?:da|unda|de|ünde)?\b/i
const ENGLISH_MUTATION = /\b(?:increment|mutat(?:e|ion)|edit|write|change|update|add|modify|create|delete|patch)\w*\b/i
const TURKISH_MUTATION = /(?:art[ıi]r|arttir|ekle|değiş|degis|yaz|güncelle|guncelle|oluştur|olustur|sil|düzenle|duzenle|\+\s*1)/i

function turnCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000) return undefined
  return value
}

function matchCount(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const matched = text.match(pattern)
    const count = turnCount(matched?.[1])
    if (count !== undefined) return count
  }
  return undefined
}

function asksForPerTurnMutation(text: string): boolean {
  const perTurn = ENGLISH_PER_TURN.test(text) || TURKISH_PER_TURN.test(text)
  const mutation = ENGLISH_MUTATION.test(text) || TURKISH_MUTATION.test(text)
  return perTurn && mutation
}

/**
 * Conservatively recognize explicit process requirements that the host can
 * corroborate without trusting the verifier model. We intentionally do not
 * infer a turn count from vague phrases such as "within 10 turns" because
 * those describe a budget/upper bound rather than a required cadence.
 */
export function inferProcessTurnExpectation(text: string): ProcessTurnExpectation | undefined {
  const source = text.trim()
  if (!source) return undefined

  const atLeast = matchCount(source, [
    /\bat\s+least\s+(\d{1,6})\s+(?:(?:separate|distinct)\s+)?(?:goal\s+)?turns?\b/i,
    /\ben\s+az\s+(\d{1,6})\s+(?:(?:ayrı|farklı)\s+)?(?:goal\s+)?tur(?:u|da|lar)?\b/i,
  ])
  if (atLeast !== undefined) {
    return { turns: atLeast, mode: "atLeast", requireMutationPerTurn: asksForPerTurnMutation(source) }
  }

  const exactly = matchCount(source, [
    /\bexactly\s+(\d{1,6})\s+(?:(?:separate|distinct)\s+)?(?:goal\s+)?turns?\b/i,
    /\b(\d{1,6})\s+(?:separate|distinct)\s+(?:goal\s+)?turns?\b/i,
    /\bacross\s+(\d{1,6})\s+(?:(?:separate|distinct)\s+)?(?:goal\s+)?turns?\b/i,
    /\bfor\s+(\d{1,6})\s+(?:separate|distinct)\s+(?:goal\s+)?turns?\b/i,
    /\b(\d{1,6})\s+(?:ayrı|farklı)\s+(?:goal\s+)?tur(?:u|da|lar)?\b/i,
    /\b(\d{1,6})\s+(?:goal\s+)?tur\s+boyunca\b/i,
  ])
  if (exactly === undefined) return undefined
  return { turns: exactly, mode: "exactly", requireMutationPerTurn: asksForPerTurnMutation(source) }
}

function runtimeMetric(records: EvidenceRecord[], key: "turns" | "mutations"): number | undefined {
  for (const record of records) {
    if (record.source !== "goal-runtime" || record.trust !== "host" || record.passed !== true) continue
    const value = record.metadata?.[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/**
 * Runtime turn/progress counters are authoritative for an explicit process
 * contract (e.g. N distinct Goal turns), but cannot certify a generic
 * deliverable such as "implement the feature" or "create the file".
 *
 * By this point verifier file quotes have been host-corroborated. Only
 * literal corroborated files or an explicitly cited, current passing
 * file/command host record may establish a non-process claim. The same
 * verified file record can support both a file requirement and the broader
 * semantic objective; requiring identical requirement IDs would break
 * legitimate shared evidence. Runtime counters never suffice.
 */
function normalizedPath(value: string | undefined): string {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function hasConcreteResultEvidence(
  goal: GoalState,
  requirementText: string,
  result: SemanticRequirementResult,
  records: EvidenceRecord[],
): boolean {
  const targets = explicitFileTargets(requirementText).map(normalizedPath)
  const deletionOnly = requestsDeletion(requirementText)
    && !/\b(?:implement|create|update|write|build|fix|add|refactor)\b/i.test(requirementText)
  const quotedPaths = new Set(result.evidence
    .filter((item) => item.path?.trim() && item.quote?.trim())
    .map((item) => normalizedPath(item.path)))
  const ids = new Set(result.hostEvidenceIDs)
  const current = records.filter((item) =>
    ids.has(item.id)
    && item.goalRevision === goal.revision
    && item.trust === "host"
    && item.passed === true,
  )
  // Merely citing a passing host check is not enough. Bind it to its
  // structured file/command contract; runtime counters have neither.
  const provedFiles = current.filter((item) => {
    if (item.kind !== "file" || !item.source || item.metadata?.absent === true) return false
    return goal.requirements.some((requirement) =>
      requirement.verification === "file"
      && requirement.file
      && normalizedPath(requirement.file) === normalizedPath(item.source)
      && item.requirementIDs.includes(requirement.id)
      && requirement.status === "proven"
      && item.metadata?.exists !== false
      && item.metadata?.regularFile !== false,
    )
  })
  const absence = current.filter((item) =>
    item.kind === "file"
    && item.metadata?.absent === true
    && item.requirementIDs.includes(result.requirementID)
    && item.source,
  )

  // Named deliverables require proof of THOSE paths, not just any README
  // contract, a generic npm test, or a host runtime/turn count.
  if (targets.length > 0) {
    return targets.every((target) =>
      deletionOnly
        ? absence.some((item) => normalizedPath(item.source) === target)
        : quotedPaths.has(target) || provedFiles.some((item) => normalizedPath(item.source) === target),
    )
  }

  // Unnamed deletion has no inspectable negative target; do not infer it from
  // a command or an unrelated file. Explicit named deletions use host absence.
  if (deletionOnly) return false
  if (quotedPaths.size > 0 || provedFiles.length > 0) return true

  // A direct check can prove a test/lint/build-only objective if the passed
  // command actually implements the named verification. "true" cannot prove
  // an implementation, and a test pass alone cannot prove a named artifact.
  const testOnly = /\b(?:tests?|lint|typecheck|checks?|build|compile|ci)\b/i.test(requirementText)
    && !/\b(?:implement|create|delete|remove|update|write|modify|fix|refactor)\b/i.test(requirementText)
  if (!testOnly) return false
  return current.some((item) =>
    item.kind === "command"
    && item.source
    && /\b(?:test|lint|check|build|compile|tsc)\b/i.test(item.source)
    && goal.requirements.some((requirement) =>
      requirement.verification === "command"
      && requirement.status === "proven"
      && requirement.command === item.source
      && item.requirementIDs.includes(requirement.id),
    ),
  )
}

function guarded(result: SemanticRequirementResult, verdict: "failed" | "unknown", reason: string): SemanticRequirementResult {
  return {
    ...result,
    verdict,
    reason: `Host process guard: ${reason} Verifier claim was not accepted as proven.`,
  }
}

/**
 * Fail closed when a verifier model claims an explicit N-turn process was
 * proven but host-owned runtime evidence does not establish that cadence.
 *
 * When the requirement explicitly asks for a workspace mutation in every Goal
 * turn, mutation fingerprints are the stronger temporal proof: the runtime
 * cadence boundary prevents a second successful file mutation in the same
 * Goal-owned turn. N distinct mutation fingerprints therefore establish N
 * distinct mutation turns without relying on OpenCode's lower-level assistant
 * message accounting, which may contain extra tool-loop messages inside one
 * logical Goal turn.
 */
export function guardSemanticProcessResults(
  goal: GoalState,
  results: SemanticRequirementResult[],
  hostEvidenceRecords: EvidenceRecord[],
): SemanticRequirementResult[] {
  const requirements = new Map(goal.requirements.map((item) => [item.id, item]))
  const turns = runtimeMetric(hostEvidenceRecords, "turns")
  const mutations = runtimeMetric(hostEvidenceRecords, "mutations")

  return results.map((result) => {
    if (result.verdict !== "proven") return result
    const requirement = requirements.get(result.requirementID)
    if (!requirement || requirement.verification !== "semantic") return result
    const expectation = inferProcessTurnExpectation(requirement.text)
    // A turn requirement can coexist with an actual deliverable. Proving
    // cadence alone must not silently prove an implementation or deleted file.
    const needsArtifact = !expectation || needsConcreteDeliverable(requirement.text, expectation.requireMutationPerTurn)
    if (needsArtifact && !hasConcreteResultEvidence(goal, requirement.text, result, hostEvidenceRecords)) {
      return guarded(result, "unknown", "non-process deliverable has only runtime counters, unrelated checks or unsupported evidence; real target-file, host absence, or directly linked verification evidence is required.")
    }
    if (!expectation) return result

    if (expectation.requireMutationPerTurn) {
      if (mutations === undefined) {
        return guarded(result, "unknown", `requirement asks for a mutation in each of ${expectation.turns} Goal turns, but host mutation evidence is unavailable.`)
      }
      if (mutations < expectation.turns) {
        return guarded(result, "unknown", `requirement asks for a mutation in each of ${expectation.turns} Goal turns, but host observed only ${mutations} distinct mutation fingerprint(s).`)
      }
      if (expectation.mode === "exactly" && mutations > expectation.turns) {
        return guarded(result, "failed", `requirement asks for exactly ${expectation.turns} mutation turns, but host observed ${mutations} distinct mutation fingerprint(s).`)
      }
      return result
    }

    if (turns === undefined) {
      return guarded(result, "unknown", `requirement asks for ${expectation.mode === "exactly" ? "exactly" : "at least"} ${expectation.turns} Goal turns, but host turn evidence is unavailable.`)
    }

    if (expectation.mode === "exactly") {
      if (turns < expectation.turns) {
        return guarded(result, "unknown", `requirement asks for exactly ${expectation.turns} Goal turns, but host observed only ${turns} current-revision assistant turn(s).`)
      }
      if (turns > expectation.turns) {
        return guarded(result, "failed", `requirement asks for exactly ${expectation.turns} Goal turns, but host observed ${turns} current-revision assistant turn(s).`)
      }
    } else if (turns < expectation.turns) {
      return guarded(result, "unknown", `requirement asks for at least ${expectation.turns} Goal turns, but host observed only ${turns} current-revision assistant turn(s).`)
    }

    return result
  })
}
