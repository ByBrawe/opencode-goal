import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { EvidenceRecord, GoalState } from "../domain/types.js"
import type { SemanticEvidenceRef, SemanticRequirementResult } from "./semantic.js"

export const DEFAULT_VERIFIER_TIMEOUT_MS = 60_000

export class SemanticVerifierUnavailableError extends Error {
  readonly code = "SEMANTIC_VERIFIER_UNAVAILABLE"

  constructor(message: string) {
    super(message)
    this.name = "SemanticVerifierUnavailableError"
  }
}

function currentRevisionTurns(goal: GoalState, currentMessageID?: string): number {
  const baseline = Math.max(0, goal.revisionTurnBaseline ?? 0)
  const completed = Math.max(0, goal.usage.turns - baseline)
  const current = currentMessageID && !goal.usage.seenMessageIDs.includes(currentMessageID) ? 1 : 0
  return completed + current
}

export function semanticVerifierHostEvidence(goal: GoalState, currentMessageID?: string): EvidenceRecord[] {
  const turns = currentRevisionTurns(goal, currentMessageID)
  const mutations = goal.progressFingerprints?.length ?? 0
  const runtime: EvidenceRecord[] = [
    {
      id: `goal-runtime-turns-r${goal.revision}`,
      kind: "runtime",
      trust: "host",
      summary: `Host-observed Goal-owned assistant turns for the current revision, including the current completion turn when applicable: ${turns}.`,
      createdAt: goal.updatedAt,
      goalRevision: goal.revision,
      requirementIDs: [],
      source: "goal-runtime",
      passed: true,
      metadata: { turns },
    },
    {
      id: `goal-runtime-progress-r${goal.revision}`,
      kind: "runtime",
      trust: "host",
      summary: `Host-observed distinct workspace mutation fingerprints for the current revision: ${mutations}.`,
      createdAt: goal.updatedAt,
      goalRevision: goal.revision,
      requirementIDs: [],
      source: "goal-runtime",
      passed: true,
      metadata: { mutations, progressRevision: goal.progressRevision },
    },
  ]
  const persisted = goal.evidence
    .filter((item) => item.goalRevision === goal.revision && item.trust === "host" && item.passed === true)
    .slice(-28)
  return [...runtime, ...persisted]
}

export function semanticVerificationPrompt(goal: GoalState, auditToken: string, hostEvidenceRecords: EvidenceRecord[]): string {
  const semantic = goal.requirements.filter((item) => item.required && item.verification === "semantic")
  const hostEvidence = hostEvidenceRecords
    .map((item) => `- [${item.id}] ${item.summary}`)
    .join("\n") || "- none"
  const request = JSON.stringify({
    auditToken,
    goalID: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    requirements: semantic.map((item) => ({ id: item.id, text: item.text })),
  }, null, 2)
  return `Independently audit the semantic requirements for an OpenCode goal.\n\nThe goal executor's claims are not proof. Inspect the current workspace yourself using only read/search tools. Never edit files, run shell commands, delegate tasks, or mutate goal state. Preserve the full requested scope.\n\nVerdicts:\n- proven: current authoritative workspace evidence directly establishes the requirement. Support proven verdicts with exact file excerpts as {path, quote} and/or IDs of current passing host evidence. The host will independently re-read file quotes and validate every host-evidence ID.\n- failed: current evidence directly contradicts the requirement.\n- unknown: evidence is missing, indirect, ambiguous, external, or would require executing a command you cannot run.\n\nPrefer a current passing host-evidence ID when it directly establishes the requirement. When citing a file, quote only literal text that exists inside that file. Never copy read-tool line numbers, path headers, XML/Markdown wrappers, labels, or explanatory prose into the quote.\n\nDo not treat a vague statement, plan, TODO, changelog claim, or unverified test claim as proof. Host-run verification evidence, when present below, may be used only for what it actually establishes. A path without an exact quote is not proof, and an unknown host-evidence ID is not proof. Temporal/process requirements such as doing an action across N distinct turns are not proven by a final file value alone: use the host runtime turn/progress evidence below and return unknown or failed when the requested cadence/count is not established.\n\nHost evidence:\n${hostEvidence}\n\nVerification request:\n${request}\n\nCall opencode_goal_verifier_result exactly once with the auditToken and one result for every listed requirement. Do not return a success verdict outside that tool.`
}

function resolveInside(root: string, candidate: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(base, candidate)
  const relative = path.relative(base, resolved)
  if (!relative || relative === ".") throw new Error("verifier evidence must reference a file inside the project root")
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("verifier evidence path escapes the project root")
  return resolved
}

function evidenceQuoteCandidates(value: string): string[] {
  const source = value.trim()
  const candidates = new Set<string>()
  const add = (candidate: string) => {
    const trimmed = candidate.trim()
    if (trimmed) candidates.add(trimmed)
  }
  add(source)
  add(source.split(/\r?\n/).map((line) => line.replace(/^\s*\d+:\s?/, "")).join("\n"))
  if (source.length >= 2) {
    const first = source[0]
    const last = source[source.length - 1]
    if (first === last && (first === "\"" || first === "'" || first === "`")) add(source.slice(1, -1))
  }
  return [...candidates]
}

export async function corroborateSemanticVerifierEvidence(
  root: string,
  goal: GoalState,
  results: SemanticRequirementResult[],
  hostEvidenceRecords: EvidenceRecord[],
): Promise<SemanticRequirementResult[]> {
  const cache = new Map<string, { content: string; sha256: string }>()
  const hostEvidenceByID = new Map(hostEvidenceRecords.map((item) => [item.id, item]))
  const readCurrentFile = async (absolute: string) => {
    let cached = cache.get(absolute)
    if (!cached) {
      const content = await fs.readFile(absolute, "utf8")
      cached = { content, sha256: createHash("sha256").update(content).digest("hex") }
      cache.set(absolute, cached)
    }
    return cached
  }
  const recoverHostFileEvidence = async (requestedQuote: string, expectedAbsolute?: string): Promise<EvidenceRecord | undefined> => {
    const quoteCandidates = evidenceQuoteCandidates(requestedQuote)
    const matches: EvidenceRecord[] = []
    for (const item of hostEvidenceRecords) {
      if (item.goalRevision !== goal.revision || item.trust !== "host" || item.passed !== true || item.kind !== "file" || !item.source) continue
      const contains = typeof item.metadata?.contains === "string" ? item.metadata.contains.trim() : ""
      const expectedSha = typeof item.metadata?.sha256 === "string" ? item.metadata.sha256.trim() : ""
      if (!contains || !expectedSha) continue
      if (!quoteCandidates.some((candidate) => candidate.includes(contains) || contains.includes(candidate))) continue
      let absolute: string
      try {
        absolute = resolveInside(root, item.source)
      } catch {
        continue
      }
      if (expectedAbsolute && absolute !== expectedAbsolute) continue
      let current: { content: string; sha256: string }
      try {
        current = await readCurrentFile(absolute)
      } catch {
        continue
      }
      if (current.sha256 !== expectedSha || !current.content.includes(contains)) continue
      matches.push(item)
    }
    return matches.length === 1 ? matches[0] : undefined
  }
  const output: SemanticRequirementResult[] = []
  for (const result of results) {
    const evidence: SemanticEvidenceRef[] = []
    const hostEvidenceIDs = new Set(result.hostEvidenceIDs.map((item) => item.trim()).filter(Boolean))
    for (const item of result.evidence) {
      const relativePath = item.path.trim()
      const requestedQuote = item.quote.trim()
      if (!relativePath || !requestedQuote) throw new Error("verifier evidence requires a non-empty path and exact quote")
      if (relativePath.length > 500 || requestedQuote.length > 1200) throw new Error("verifier evidence reference is too large")
      let absolute: string
      try {
        absolute = resolveInside(root, relativePath)
      } catch (error) {
        const recovered = await recoverHostFileEvidence(requestedQuote)
        if (recovered) {
          hostEvidenceIDs.add(recovered.id)
          continue
        }
        throw error
      }
      const cached = await readCurrentFile(absolute)
      const quote = evidenceQuoteCandidates(requestedQuote).find((candidate) => cached.content.includes(candidate))
      if (!quote) {
        const recovered = await recoverHostFileEvidence(requestedQuote, absolute)
        if (recovered) {
          hostEvidenceIDs.add(recovered.id)
          continue
        }
        throw new Error(`verifier evidence quote was not found in ${relativePath}`)
      }
      evidence.push({ path: relativePath, quote, sha256: cached.sha256 })
    }
    const normalizedHostEvidenceIDs = [...hostEvidenceIDs]
    for (const id of normalizedHostEvidenceIDs) {
      const hostEvidence = hostEvidenceByID.get(id)
      if (!hostEvidence || hostEvidence.goalRevision !== goal.revision || hostEvidence.trust !== "host" || hostEvidence.passed !== true) {
        throw new Error(`verifier referenced invalid or non-passing host evidence: ${id}`)
      }
    }
    if (result.verdict === "proven" && evidence.length === 0 && normalizedHostEvidenceIDs.length === 0) {
      throw new Error("proven semantic requirement lacks current corroborated evidence")
    }
    output.push({ ...result, evidence, hostEvidenceIDs: normalizedHostEvidenceIDs })
  }
  return output
}
