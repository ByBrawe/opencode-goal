import type { EvidenceRecord, GoalState } from "../domain/types.js"
import type { SemanticRequirementResult } from "./semantic.js"

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
 * This makes temporal correctness independent of verifier model quality.
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
    if (!expectation) return result

    if (turns === undefined) {
      return guarded(result, "unknown", `requirement asks for ${expectation.mode === "exactly" ? "exactly" : "at least"} ${expectation.turns} Goal turns, but host turn evidence is unavailable.`)
    }

    if (expectation.mode === "exactly") {
      if (turns < expectation.turns) {
        return guarded(result, "unknown", `requirement asks for exactly ${expectation.turns} Goal turns, but host observed only ${turns} current-revision turn(s).`)
      }
      if (turns > expectation.turns) {
        return guarded(result, "failed", `requirement asks for exactly ${expectation.turns} Goal turns, but host observed ${turns} current-revision turn(s).`)
      }
    } else if (turns < expectation.turns) {
      return guarded(result, "unknown", `requirement asks for at least ${expectation.turns} Goal turns, but host observed only ${turns} current-revision turn(s).`)
    }

    if (expectation.requireMutationPerTurn) {
      if (mutations === undefined) {
        return guarded(result, "unknown", `requirement asks for a mutation in each of ${expectation.turns} Goal turns, but host mutation evidence is unavailable.`)
      }
      if (mutations < expectation.turns) {
        return guarded(result, "unknown", `requirement asks for a mutation in each of ${expectation.turns} Goal turns, but host observed only ${mutations} distinct mutation fingerprint(s).`)
      }
    }

    return result
  })
}
