import { randomUUID } from "node:crypto"
import type { GoalState } from "../domain/types.js"
import { guardSemanticProcessResults } from "../verification/process.js"
import {
  applySemanticVerifierResults,
  type SemanticEvidenceRef,
  type SemanticRequirementResult,
} from "../verification/semantic.js"
import {
  DEFAULT_VERIFIER_TIMEOUT_MS,
  SemanticVerifierUnavailableError,
  corroborateSemanticVerifierEvidence,
  semanticVerificationPrompt,
  semanticVerifierHostEvidence,
} from "../opencode/verifier.js"

export const OPENCODE2_VERIFIER_RESULT_TOOL = "opencode_goal_verifier_result"

const VERIFIER_CLEANUP_TIMEOUT_MS = 1_500
const VERIFIER_TIMEOUT_RETRY_MAX_MS = 60_000
const VERIFIER_SYSTEM_PROMPT =
  "Act only as an independent completion verifier. Inspect current workspace evidence with read-only tools, preserve scope, fail closed on uncertainty, never modify files or execute commands, and submit verdicts only through opencode_goal_verifier_result."

type UnknownRecord = Record<string, unknown>

export interface OpenCode2VerifierSessionAPI {
  create?(input: { parentID: string; title?: string }): unknown | Promise<unknown>
  prompt?(input: {
    sessionID: string
    id?: string
    text: string
    delivery?: "steer" | "queue" | null
    resume?: boolean | null
    metadata?: Readonly<UnknownRecord>
  }): unknown | Promise<unknown>
  wait?(input: { sessionID: string }): unknown | Promise<unknown>
  delete?(input: { sessionID: string }): unknown | Promise<unknown>
  interrupt?(input: { sessionID: string; resume?: boolean }): unknown | Promise<unknown>
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

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? value as UnknownRecord : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function sessionIDFromContext(event: unknown): string | undefined {
  const item = record(event)
  return firstString(item?.sessionID, record(item?.data)?.sessionID, record(item?.properties)?.sessionID)
}

function appendSystem(event: any, text: string): void {
  if (!event) return
  if (Array.isArray(event.system)) {
    const already = event.system.some((part: unknown) => {
      if (typeof part === "string") return part === text
      const item = record(part)
      return item?.type === "text" && item?.text === text
    })
    if (already) return
    const structured = event.system.length === 0 || event.system.some((part: unknown) => record(part)?.type === "text")
    event.system.push(structured ? { type: "text", text } : text)
    return
  }
  if (typeof event.system === "string") {
    if (!event.system.includes(text)) event.system = event.system ? `${event.system}\n\n${text}` : text
    return
  }
  event.system = [{ type: "text", text }]
}

function validationResult(
  request: PendingAudit,
  args: any,
): { results?: SemanticRequirementResult[]; rejection?: string } {
  if (args?.auditToken !== request.auditToken) return { rejection: "Rejected: verifier audit token does not match." }
  if (!Array.isArray(args?.results)) return { rejection: "Rejected: verifier results must be an array." }

  const ids = args.results.map((item: any) => String(item?.requirementID ?? ""))
  if (ids.length !== request.expectedRequirementIDs.size || new Set(ids).size !== ids.length) {
    return { rejection: "Rejected: verifier must submit each semantic requirement exactly once." }
  }
  if (ids.some((id: string) => !request.expectedRequirementIDs.has(id))) {
    return { rejection: "Rejected: verifier result contains an unexpected requirement." }
  }

  const results: SemanticRequirementResult[] = []
  for (const item of args.results) {
    const verdict = String(item?.verdict ?? "")
    const reason = String(item?.reason ?? "").trim()
    const evidence = Array.isArray(item?.evidence)
      ? item.evidence
        .map((value: any) => ({
          path: String(value?.path ?? "").trim(),
          quote: String(value?.quote ?? "").trim(),
        }))
        .filter((value: SemanticEvidenceRef) => value.path && value.quote)
      : []
    const hostEvidenceIDs = Array.isArray(item?.hostEvidenceIDs)
      ? item.hostEvidenceIDs.map((value: unknown) => String(value).trim()).filter(Boolean)
      : []

    if (!["proven", "failed", "unknown"].includes(verdict) || !reason) {
      return { rejection: "Rejected: invalid verifier verdict." }
    }
    if (verdict === "proven" && evidence.length === 0 && hostEvidenceIDs.length === 0) {
      return { rejection: "Rejected: proven requirements need current corroborated evidence." }
    }
    if (
      evidence.some((value: SemanticEvidenceRef) => value.path.length > 500 || value.quote.length > 1200)
      || hostEvidenceIDs.some((id: string) => id.length > 100)
      || reason.length > 2000
    ) {
      return { rejection: "Rejected: verifier result is too large." }
    }
    results.push({
      requirementID: String(item.requirementID),
      verdict: verdict as SemanticRequirementResult["verdict"],
      reason,
      evidence,
      hostEvidenceIDs,
    })
  }
  return { results }
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

async function abortVerifier(session: OpenCode2VerifierSessionAPI, childID: string): Promise<void> {
  await bestEffortWithin(
    typeof session.interrupt === "function"
      ? () => Promise.resolve(session.interrupt!({ sessionID: childID, resume: false }))
      : undefined,
  )
}

async function withinVerifierDeadline<T>(
  session: OpenCode2VerifierSessionAPI,
  childID: string,
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
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
    if (timedOut && childID) await abortVerifier(session, childID)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createOpenCode2SemanticVerifierRuntime(
  session: OpenCode2VerifierSessionAPI,
  resolveRoot: (parentSessionID: string) => Promise<string>,
  options: { timeoutMs?: number } = {},
) {
  const pending = new Map<string, PendingAudit>()
  const submitted = new Map<string, SubmittedAudit>()
  const resultSignals = new Map<string, () => void>()
  const verifierSessions = new Set<string>()
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_VERIFIER_TIMEOUT_MS

  const resultTool = {
    description: "Submit the independent semantic verification verdict for the currently assigned Goal audit.",
    input: {
      type: "object",
      properties: {
        auditToken: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              requirementID: { type: "string" },
              verdict: { type: "string", enum: ["proven", "failed", "unknown"] },
              reason: { type: "string" },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    quote: { type: "string" },
                  },
                  required: ["path", "quote"],
                  additionalProperties: false,
                },
              },
              hostEvidenceIDs: { type: "array", items: { type: "string" } },
            },
            required: ["requirementID", "verdict", "reason", "evidence", "hostEvidenceIDs"],
            additionalProperties: false,
          },
        },
      },
      required: ["auditToken", "results"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    execute: async (args: any, context: any) => {
      const childID = firstString(context?.sessionID)
      if (!childID) {
        return { output: { message: "Rejected: verifier result is missing a session identity." }, content: "Rejected: verifier result is missing a session identity." }
      }
      const request = pending.get(childID)
      if (!request) {
        return { output: { message: "Rejected: this session has no active semantic verification audit." }, content: "Rejected: this session has no active semantic verification audit." }
      }
      if (submitted.has(childID)) {
        return { output: { message: "Rejected: a verifier result was already submitted for this audit." }, content: "Rejected: a verifier result was already submitted for this audit." }
      }
      const checked = validationResult(request, args)
      if (!checked.results) {
        const rejection = checked.rejection ?? "Rejected: invalid verifier result."
        return { output: { message: rejection }, content: rejection }
      }
      submitted.set(childID, { auditToken: request.auditToken, results: checked.results })
      resultSignals.get(childID)?.()
      return { output: { message: "Semantic verifier result accepted." }, content: "Semantic verifier result accepted." }
    },
  }

  function handleContext(event: any): boolean {
    const sessionID = sessionIDFromContext(event)
    if (!sessionID || !verifierSessions.has(sessionID)) {
      if (event?.tools && typeof event.tools === "object") delete event.tools[OPENCODE2_VERIFIER_RESULT_TOOL]
      return false
    }

    if (event?.tools && typeof event.tools === "object") {
      const allowed = new Set(["read", "glob", "grep", OPENCODE2_VERIFIER_RESULT_TOOL])
      for (const name of Object.keys(event.tools)) {
        if (!allowed.has(name)) delete event.tools[name]
      }
    }
    appendSystem(event, VERIFIER_SYSTEM_PROMPT)
    return true
  }

  async function verify(
    parentSessionID: string,
    goal: GoalState,
    verifyOptions: { currentMessageID?: string; timeoutMs?: number; allowTimeoutRetry?: boolean } = {},
  ): Promise<GoalState> {
    const semantic = goal.requirements.filter((item) => item.required && item.verification === "semantic")
    if (semantic.length === 0) return goal
    if (typeof session.create !== "function" || typeof session.prompt !== "function") {
      throw new SemanticVerifierUnavailableError("OpenCode 2 semantic verifier requires session.create() and session.prompt()")
    }

    const deadlineMs = Number.isFinite(verifyOptions.timeoutMs) && Number(verifyOptions.timeoutMs) > 0
      ? Number(verifyOptions.timeoutMs)
      : timeoutMs
    const allowTimeoutRetry = verifyOptions.allowTimeoutRetry !== false
    const auditToken = randomUUID()
    const root = await resolveRoot(parentSessionID)
    const hostEvidenceRecords = semanticVerifierHostEvidence(goal, verifyOptions.currentMessageID)
    let childID = ""
    let retryAfterTimeout = false

    try {
      let created: unknown
      try {
        created = await withinVerifierDeadline(
          session,
          "",
          Promise.resolve(session.create({ parentID: parentSessionID, title: "Goal verification" })),
          deadlineMs,
        )
      } catch (error) {
        if (error instanceof SemanticVerifierUnavailableError) throw error
        throw new SemanticVerifierUnavailableError(`semantic verifier session creation failed: ${String(error)}`)
      }
      childID = firstString(record(created)?.id, record(record(created)?.data)?.id) ?? ""
      if (!childID) throw new SemanticVerifierUnavailableError("OpenCode did not return a verifier session id")

      verifierSessions.add(childID)
      pending.set(childID, {
        auditToken,
        parentSessionID,
        goalID: goal.id,
        revision: goal.revision,
        expectedRequirementIDs: new Set(semantic.map((item) => item.id)),
      })

      let resolveResult!: () => void
      const resultSignal = new Promise<void>((resolve) => { resolveResult = resolve })
      resultSignals.set(childID, resolveResult)

      const text = semanticVerificationPrompt(goal, auditToken, hostEvidenceRecords)
      let admitted: unknown
      try {
        admitted = await withinVerifierDeadline(
          session,
          childID,
          Promise.resolve(session.prompt({
            sessionID: childID,
            text,
            delivery: "steer",
            resume: false,
            metadata: {
              opencode_goal_v2_verifier: true,
              opencode_goal_id: goal.id,
              opencode_goal_revision: goal.revision,
            },
          })),
          deadlineMs,
        )
      } catch (error) {
        if (error instanceof SemanticVerifierUnavailableError) throw error
        throw new SemanticVerifierUnavailableError(`semantic verifier dispatch admission failed: ${String(error)}`)
      }
      const messageID = firstString(record(admitted)?.id, record(record(admitted)?.data)?.id)
      if (!messageID) throw new SemanticVerifierUnavailableError("OpenCode did not return a verifier prompt message id")

      try {
        const resumed = Promise.resolve(session.prompt({
          sessionID: childID,
          id: messageID,
          text,
          delivery: "steer",
          resume: true,
          metadata: {
            opencode_goal_v2_verifier: true,
            opencode_goal_id: goal.id,
            opencode_goal_revision: goal.revision,
          },
        }))
        await withinVerifierDeadline(
          session,
          childID,
          Promise.all([resumed, resultSignal]).then(() => undefined),
          deadlineMs,
        )
        if (typeof session.wait === "function") {
          await withinVerifierDeadline(
            session,
            childID,
            Promise.resolve(session.wait({ sessionID: childID })).then(() => undefined),
            deadlineMs,
          )
        }
      } catch (error) {
        if (error instanceof SemanticVerifierUnavailableError) throw error
        await abortVerifier(session, childID)
        throw new SemanticVerifierUnavailableError(`semantic verifier dispatch failed: ${String(error)}`)
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
        verifierSessions.delete(childID)
        await bestEffortWithin(
          typeof session.delete === "function"
            ? () => Promise.resolve(session.delete!({ sessionID: childID }))
            : undefined,
        )
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
    resultTool,
    handleContext,
    verify,
    isVerifierSession(sessionID: string) { return verifierSessions.has(sessionID) },
    get timeout() { return timeoutMs },
  }
}
