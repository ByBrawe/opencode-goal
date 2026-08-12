import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin/tool"
import type { EvidenceRecord, GoalState } from "../domain/types.js"
import { guardSemanticProcessResults } from "../verification/process.js"
import { applySemanticVerifierResults, type SemanticEvidenceRef, type SemanticRequirementResult } from "../verification/semantic.js"

export const DEFAULT_VERIFIER_AGENT = "opencode-goal-verifier"
export const DEFAULT_VERIFIER_TIMEOUT_MS = 60_000
const VERIFIER_CLEANUP_TIMEOUT_MS = 1_500
const VERIFIER_DESCRIPTION = "Independently verify semantic goal requirements without modifying the workspace."
const VERIFIER_AGENT_PROMPT = "Act only as an independent completion verifier. Inspect current workspace evidence, preserve scope, fail closed on uncertainty, never modify files or execute commands, and submit verdicts only through opencode_goal_verifier_result."

export interface SemanticVerifierOptions {
  timeoutMs?: number | undefined
  /** OpenCode model ref in provider/model format. When omitted, small_model/model host config is preferred. */
  model?: string | undefined
}

export class SemanticVerifierUnavailableError extends Error {
  readonly code = "SEMANTIC_VERIFIER_UNAVAILABLE"

  constructor(message: string) {
    super(message)
    this.name = "SemanticVerifierUnavailableError"
  }
}

interface PendingAudit {
  auditToken: string
  parentSessionID: string
  goalID: string
  revision: number
  expectedRequirementIDs: Set<string>
}

interface SubmittedAudit {
  auditToken: string
  results: SemanticRequirementResult[]
}

function unwrapData<T = any>(value: any): T {
  return (value && typeof value === "object" && "data" in value ? value.data : value) as T
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function sdkResponseError(value: any): string | null {
  if (!value || typeof value !== "object" || !("error" in value) || !value.error) return null
  return errorText(value.error)
}

function normalizeModelRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || !trimmed.includes("/")) return undefined
  return trimmed
}

function currentRevisionTurns(goal: GoalState, currentMessageID?: string): number {
  const baseline = Math.max(0, goal.revisionTurnBaseline ?? 0)
  const completed = Math.max(0, goal.usage.turns - baseline)
  const current = currentMessageID && !goal.usage.seenMessageIDs.includes(currentMessageID) ? 1 : 0
  return completed + current
}

function verifierHostEvidence(goal: GoalState, currentMessageID?: string): EvidenceRecord[] {
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

function verificationPrompt(goal: GoalState, auditToken: string, hostEvidenceRecords: EvidenceRecord[]): string {
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
  return `Independently audit the semantic requirements for an OpenCode goal.\n\nThe goal executor's claims are not proof. Inspect the current workspace yourself using only read/search tools. Never edit files, run shell commands, delegate tasks, or mutate goal state. Preserve the full requested scope.\n\nVerdicts:\n- proven: current authoritative workspace evidence directly establishes the requirement. Support proven verdicts with exact file excerpts as {path, quote} and/or IDs of current passing host evidence. The host will independently re-read file quotes and validate every host-evidence ID.\n- failed: current evidence directly contradicts the requirement.\n- unknown: evidence is missing, indirect, ambiguous, external, or would require executing a command you cannot run.\n\nDo not treat a vague statement, plan, TODO, changelog claim, or unverified test claim as proof. Host-run verification evidence, when present below, may be used only for what it actually establishes. A path without an exact quote is not proof, and an unknown host-evidence ID is not proof. Temporal/process requirements such as doing an action across N distinct turns are not proven by a final file value alone: use the host runtime turn/progress evidence below and return unknown or failed when the requested cadence/count is not established.\n\nHost evidence:\n${hostEvidence}\n\nVerification request:\n${request}\n\nCall opencode_goal_verifier_result exactly once with the auditToken and one result for every listed requirement. Do not return a success verdict outside that tool.`
}

function resolveInside(root: string, candidate: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(base, candidate)
  const relative = path.relative(base, resolved)
  if (!relative || relative === ".") throw new Error("verifier evidence must reference a file inside the project root")
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("verifier evidence path escapes the project root")
  return resolved
}

async function corroborateEvidence(
  root: string,
  goal: GoalState,
  results: SemanticRequirementResult[],
  hostEvidenceRecords: EvidenceRecord[],
): Promise<SemanticRequirementResult[]> {
  const cache = new Map<string, { content: string; sha256: string }>()
  const hostEvidenceByID = new Map(hostEvidenceRecords.map((item) => [item.id, item]))
  const output: SemanticRequirementResult[] = []
  for (const result of results) {
    const evidence: SemanticEvidenceRef[] = []
    for (const item of result.evidence) {
      const relativePath = item.path.trim()
      const quote = item.quote.trim()
      if (!relativePath || !quote) throw new Error("verifier evidence requires a non-empty path and exact quote")
      if (relativePath.length > 500 || quote.length > 1200) throw new Error("verifier evidence reference is too large")
      const absolute = resolveInside(root, relativePath)
      let cached = cache.get(absolute)
      if (!cached) {
        const content = await fs.readFile(absolute, "utf8")
        cached = { content, sha256: createHash("sha256").update(content).digest("hex") }
        cache.set(absolute, cached)
      }
      if (!cached.content.includes(quote)) {
        throw new Error(`verifier evidence quote was not found in ${relativePath}`)
      }
      evidence.push({ path: relativePath, quote, sha256: cached.sha256 })
    }
    const hostEvidenceIDs = [...new Set(result.hostEvidenceIDs.map((item) => item.trim()).filter(Boolean))]
    for (const id of hostEvidenceIDs) {
      const hostEvidence = hostEvidenceByID.get(id)
      if (!hostEvidence || hostEvidence.goalRevision !== goal.revision || hostEvidence.trust !== "host" || hostEvidence.passed !== true) {
        throw new Error(`verifier referenced invalid or non-passing host evidence: ${id}`)
      }
    }
    if (result.verdict === "proven" && evidence.length === 0 && hostEvidenceIDs.length === 0) {
      throw new Error("proven semantic requirement lacks current corroborated evidence")
    }
    output.push({ ...result, evidence, hostEvidenceIDs })
  }
  return output
}

async function bestEffortWithin(action: (() => Promise<unknown>) | undefined, timeoutMs = VERIFIER_CLEANUP_TIMEOUT_MS): Promise<void> {
  if (!action) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([
      Promise.resolve().then(action).then(() => undefined).catch(() => undefined),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function abortVerifier(client: any, childID: string): Promise<void> {
  await bestEffortWithin(client.session.abort
    ? () => client.session.abort({ path: { id: childID } })
    : undefined)
}

async function withinVerifierDeadline<T>(client: any, childID: string, work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new SemanticVerifierUnavailableError(`semantic verifier timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } catch (error) {
    if (timedOut && childID) await abortVerifier(client, childID)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createSemanticVerifierRuntime(client: any, root: string, options: SemanticVerifierOptions = {}) {
  const pending = new Map<string, PendingAudit>()
  const submitted = new Map<string, SubmittedAudit>()
  const resultSignals = new Map<string, () => void>()
  const agentName = DEFAULT_VERIFIER_AGENT
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_VERIFIER_TIMEOUT_MS
  const explicitModel = normalizeModelRef(options.model)
  let resolvedModel = explicitModel

  function configure(config: any) {
    config.agent ||= {}
    resolvedModel = explicitModel ?? normalizeModelRef(config.small_model) ?? normalizeModelRef(config.model)
    const existing = config.agent[agentName]
    if (existing) {
      if (existing.hidden === true && existing.description === VERIFIER_DESCRIPTION && existing.prompt === VERIFIER_AGENT_PROMPT) {
        if (resolvedModel) existing.model = resolvedModel
        return
      }
      throw new Error(`Cannot safely register internal verifier agent ${agentName}: name already exists`)
    }
    config.agent[agentName] = {
      description: VERIFIER_DESCRIPTION,
      mode: "subagent",
      hidden: true,
      prompt: VERIFIER_AGENT_PROMPT,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        opencode_goal_verifier_result: "allow",
      },
    }
  }

  const resultTool = tool({
    description: "Submit the independent semantic verification verdict for the currently assigned goal audit.",
    args: {
      auditToken: tool.schema.string(),
      results: tool.schema.array(tool.schema.object({
        requirementID: tool.schema.string(),
        verdict: tool.schema.enum(["proven", "failed", "unknown"]),
        reason: tool.schema.string(),
        evidence: tool.schema.array(tool.schema.object({
          path: tool.schema.string(),
          quote: tool.schema.string(),
        })),
        hostEvidenceIDs: tool.schema.array(tool.schema.string()),
      })),
    },
    execute: async (args: any, context: any) => {
      const request = pending.get(context.sessionID)
      if (!request) return "Rejected: this session has no active semantic verification audit."
      if (submitted.has(context.sessionID)) return "Rejected: a verifier result was already submitted for this audit."
      if (args.auditToken !== request.auditToken) return "Rejected: verifier audit token does not match."
      if (!Array.isArray(args.results)) return "Rejected: verifier results must be an array."
      const ids = args.results.map((item: any) => String(item.requirementID ?? ""))
      if (ids.length !== request.expectedRequirementIDs.size || new Set(ids).size !== ids.length) {
        return "Rejected: verifier must submit each semantic requirement exactly once."
      }
      if (ids.some((id: string) => !request.expectedRequirementIDs.has(id))) {
        return "Rejected: verifier result contains an unexpected requirement."
      }
      const results: SemanticRequirementResult[] = []
      for (const item of args.results) {
        const verdict = String(item.verdict ?? "")
        const reason = String(item.reason ?? "").trim()
        const evidence = Array.isArray(item.evidence)
          ? item.evidence.map((value: any) => ({ path: String(value?.path ?? "").trim(), quote: String(value?.quote ?? "").trim() })).filter((value: SemanticEvidenceRef) => value.path && value.quote)
          : []
        const hostEvidenceIDs = Array.isArray(item.hostEvidenceIDs) ? item.hostEvidenceIDs.map((value: unknown) => String(value).trim()).filter(Boolean) : []
        if (!["proven", "failed", "unknown"].includes(verdict) || !reason) return "Rejected: invalid verifier verdict."
        if (verdict === "proven" && evidence.length === 0 && hostEvidenceIDs.length === 0) return "Rejected: proven requirements need current corroborated evidence."
        if (evidence.some((value: SemanticEvidenceRef) => value.path.length > 500 || value.quote.length > 1200) || hostEvidenceIDs.some((id: string) => id.length > 100) || reason.length > 2000) return "Rejected: verifier result is too large."
        results.push({ requirementID: String(item.requirementID), verdict: verdict as SemanticRequirementResult["verdict"], reason, evidence, hostEvidenceIDs })
      }
      submitted.set(context.sessionID, { auditToken: request.auditToken, results })
      resultSignals.get(context.sessionID)?.()
      return "Semantic verifier result accepted."
    },
  })

  async function verify(parentSessionID: string, goal: GoalState, verifyOptions: { currentMessageID?: string } = {}): Promise<GoalState> {
    const semantic = goal.requirements.filter((item) => item.required && item.verification === "semantic")
    if (semantic.length === 0) return goal
    const auditToken = randomUUID()
    const hostEvidenceRecords = verifierHostEvidence(goal, verifyOptions.currentMessageID)
    let childID = ""
    try {
      let created: any
      try {
        created = unwrapData<any>(await withinVerifierDeadline(
          client,
          "",
          Promise.resolve().then(() => client.session.create({ body: { parentID: parentSessionID, title: "Goal verification" } })),
          timeoutMs,
        ))
      } catch (error) {
        throw new SemanticVerifierUnavailableError(`semantic verifier session creation failed: ${errorText(error)}`)
      }
      childID = String(created?.id ?? "")
      if (!childID) throw new SemanticVerifierUnavailableError("OpenCode did not return a verifier session id")
      pending.set(childID, {
        auditToken,
        parentSessionID,
        goalID: goal.id,
        revision: goal.revision,
        expectedRequirementIDs: new Set(semantic.map((item) => item.id)),
      })
      // Deliberately do not pass goal.execution.model here. The verifier is an
      // independent system agent and must not be forced onto the executor's
      // weak/free/session-selected model. Its model comes from the verifier
      // agent config (explicit option -> small_model -> default model).
      const body = {
        agent: agentName,
        parts: [{ type: "text", text: verificationPrompt(goal, auditToken, hostEvidenceRecords) }],
      }

      if (typeof client.session.promptAsync === "function") {
        let resolveResult!: () => void
        const resultSignal = new Promise<void>((resolve) => { resolveResult = resolve })
        resultSignals.set(childID, resolveResult)
        let dispatched: any
        try {
          dispatched = await withinVerifierDeadline(
            client,
            childID,
            Promise.resolve().then(() => client.session.promptAsync({ path: { id: childID }, body })),
            timeoutMs,
          )
        } catch (error) {
          if (error instanceof SemanticVerifierUnavailableError) throw error
          await abortVerifier(client, childID)
          throw new SemanticVerifierUnavailableError(`semantic verifier async dispatch failed: ${errorText(error)}`)
        }
        const dispatchError = sdkResponseError(dispatched)
        if (dispatchError) {
          await abortVerifier(client, childID)
          throw new SemanticVerifierUnavailableError(`semantic verifier async dispatch failed: ${dispatchError}`)
        }
        await withinVerifierDeadline(client, childID, resultSignal, timeoutMs)
      } else {
        try {
          await withinVerifierDeadline(
            client,
            childID,
            Promise.resolve(client.session.prompt({ path: { id: childID }, body })).then((response) => {
              const dispatchError = sdkResponseError(response)
              if (dispatchError) throw new Error(dispatchError)
            }),
            timeoutMs,
          )
        } catch (error) {
          if (error instanceof SemanticVerifierUnavailableError) throw error
          await abortVerifier(client, childID)
          throw new SemanticVerifierUnavailableError(`semantic verifier dispatch failed: ${errorText(error)}`)
        }
      }

      const result = submitted.get(childID)
      if (!result || result.auditToken !== auditToken) {
        throw new Error("semantic verifier did not submit a valid result")
      }
      const corroborated = await corroborateEvidence(root, goal, result.results, hostEvidenceRecords)
      const processGuarded = guardSemanticProcessResults(goal, corroborated, hostEvidenceRecords)
      return applySemanticVerifierResults(goal, processGuarded)
    } finally {
      if (childID) {
        pending.delete(childID)
        submitted.delete(childID)
        resultSignals.delete(childID)
        await bestEffortWithin(client.session.delete
          ? () => client.session.delete({ path: { id: childID } })
          : undefined)
      }
    }
  }

  return {
    configure,
    resultTool,
    verify,
    get agentName() { return agentName },
    get model() { return resolvedModel },
    get timeout() { return timeoutMs },
  }
}
