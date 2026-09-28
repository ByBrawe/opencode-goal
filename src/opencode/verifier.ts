import { DEFAULT_VERIFIER_TIMEOUT_MS, SemanticVerifierUnavailableError, corroborateSemanticVerifierEvidence, semanticVerificationPrompt, semanticVerifierHostEvidence } from "../verification/verifier-evidence.js"
export { DEFAULT_VERIFIER_TIMEOUT_MS, SemanticVerifierUnavailableError, corroborateSemanticVerifierEvidence, semanticVerificationPrompt, semanticVerifierHostEvidence } from "../verification/verifier-evidence.js"
import { randomUUID } from "node:crypto"
import { tool } from "@opencode-ai/plugin/tool"
import type { EvidenceRecord, GoalState } from "../domain/types.js"
import { guardSemanticProcessResults } from "../verification/process.js"
import { applySemanticVerifierResults, type SemanticEvidenceRef, type SemanticRequirementResult } from "../verification/semantic.js"

export const DEFAULT_VERIFIER_AGENT = "opencode-goal-verifier"
const VERIFIER_CLEANUP_TIMEOUT_MS = 1_500
const VERIFIER_TIMEOUT_RETRY_MAX_MS = 60_000
const VERIFIER_DESCRIPTION = "Independently verify semantic goal requirements without modifying the workspace."
const VERIFIER_AGENT_PROMPT = "Act only as an independent completion verifier. Inspect current workspace evidence, preserve scope, fail closed on uncertainty, never modify files or execute commands, and submit verdicts only through opencode_goal_verifier_result."

export interface SemanticVerifierOptions {
  timeoutMs?: number | undefined
  /** OpenCode model ref in provider/model format. When omitted, small_model/model host config is preferred. */
  model?: string | undefined
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

  async function verify(
    parentSessionID: string,
    goal: GoalState,
    verifyOptions: { currentMessageID?: string; timeoutMs?: number; allowTimeoutRetry?: boolean } = {},
  ): Promise<GoalState> {
    const semantic = goal.requirements.filter((item) => item.required && item.verification === "semantic")
    if (semantic.length === 0) return goal
    const deadlineMs = Number.isFinite(verifyOptions.timeoutMs) && Number(verifyOptions.timeoutMs) > 0
      ? Number(verifyOptions.timeoutMs)
      : timeoutMs
    const allowTimeoutRetry = verifyOptions.allowTimeoutRetry !== false
    const auditToken = randomUUID()
    const hostEvidenceRecords = semanticVerifierHostEvidence(goal, verifyOptions.currentMessageID)
    let childID = ""
    let retryAfterTimeout = false
    try {
      let created: any
      try {
        created = unwrapData<any>(await withinVerifierDeadline(
          client,
          "",
          Promise.resolve().then(() => client.session.create({ body: { parentID: parentSessionID, title: "Goal verification" } })),
          deadlineMs,
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
        parts: [{ type: "text", text: semanticVerificationPrompt(goal, auditToken, hostEvidenceRecords) }],
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
            deadlineMs,
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
        await withinVerifierDeadline(client, childID, resultSignal, deadlineMs)
      } else {
        try {
          await withinVerifierDeadline(
            client,
            childID,
            Promise.resolve(client.session.prompt({ path: { id: childID }, body })).then((response) => {
              const dispatchError = sdkResponseError(response)
              if (dispatchError) throw new Error(dispatchError)
            }),
            deadlineMs,
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
      const corroborated = await corroborateSemanticVerifierEvidence(root, goal, result.results, hostEvidenceRecords)
      const processGuarded = guardSemanticProcessResults(goal, corroborated, hostEvidenceRecords)
      return applySemanticVerifierResults(goal, processGuarded)
    } catch (error) {
      retryAfterTimeout = allowTimeoutRetry
        && error instanceof SemanticVerifierUnavailableError
        && /semantic verifier timed out after \d+ms/.test(error.message)
      if (!retryAfterTimeout) throw error
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

    const retryTimeoutMs = Math.min(deadlineMs, VERIFIER_TIMEOUT_RETRY_MAX_MS)
    try {
      return await verify(parentSessionID, goal, {
        ...(verifyOptions.currentMessageID ? { currentMessageID: verifyOptions.currentMessageID } : {}),
        timeoutMs: retryTimeoutMs,
        allowTimeoutRetry: false,
      })
    } catch (error) {
      if (error instanceof SemanticVerifierUnavailableError) {
        throw new SemanticVerifierUnavailableError(`semantic verifier unavailable after one automatic timeout retry: ${error.message}`)
      }
      throw error
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
