import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin/tool"
import type { GoalState } from "../domain/types.js"
import { applySemanticVerifierResults, type SemanticEvidenceRef, type SemanticRequirementResult } from "../verification/semantic.js"

export const DEFAULT_VERIFIER_AGENT = "opencode-goal-verifier"
const VERIFIER_DESCRIPTION = "Independently verify semantic goal requirements without modifying the workspace."
const VERIFIER_AGENT_PROMPT = "Act only as an independent completion verifier. Inspect current workspace evidence, preserve scope, fail closed on uncertainty, never modify files or execute commands, and submit verdicts only through opencode_goal_verifier_result."

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

function verificationPrompt(goal: GoalState, auditToken: string): string {
  const semantic = goal.requirements.filter((item) => item.required && item.verification === "semantic")
  const hostEvidence = goal.evidence
    .filter((item) => item.goalRevision === goal.revision && item.trust === "host")
    .slice(-30)
    .map((item) => `- [${item.id}] ${item.summary}`)
    .join("\n") || "- none"
  const request = JSON.stringify({
    auditToken,
    goalID: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    requirements: semantic.map((item) => ({ id: item.id, text: item.text })),
  }, null, 2)
  return `Independently audit the semantic requirements for an OpenCode goal.\n\nThe goal executor's claims are not proof. Inspect the current workspace yourself using only read/search tools. Never edit files, run shell commands, delegate tasks, or mutate goal state. Preserve the full requested scope.\n\nVerdicts:\n- proven: current authoritative workspace evidence directly establishes the requirement. Support proven verdicts with exact file excerpts as {path, quote} and/or IDs of current passing host evidence. The host will independently re-read file quotes and validate every host-evidence ID.\n- failed: current evidence directly contradicts the requirement.\n- unknown: evidence is missing, indirect, ambiguous, external, or would require executing a command you cannot run.\n\nDo not treat a vague statement, plan, TODO, changelog claim, or unverified test claim as proof. Host-run verification evidence, when present below, may be used only for what it actually establishes. A path without an exact quote is not proof, and an unknown host-evidence ID is not proof.\n\nHost evidence:\n${hostEvidence}\n\nVerification request:\n${request}\n\nCall opencode_goal_verifier_result exactly once with the auditToken and one result for every listed requirement. Do not return a success verdict outside that tool.`
}

function resolveInside(root: string, candidate: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(base, candidate)
  const relative = path.relative(base, resolved)
  if (!relative || relative === ".") throw new Error("verifier evidence must reference a file inside the project root")
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("verifier evidence path escapes the project root")
  return resolved
}

async function corroborateEvidence(root: string, goal: GoalState, results: SemanticRequirementResult[]): Promise<SemanticRequirementResult[]> {
  const cache = new Map<string, { content: string; sha256: string }>()
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
      const hostEvidence = goal.evidence.find((item) => item.id === id)
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

export function createSemanticVerifierRuntime(client: any, root: string) {
  const pending = new Map<string, PendingAudit>()
  const submitted = new Map<string, SubmittedAudit>()
  const agentName = DEFAULT_VERIFIER_AGENT

  function configure(config: any) {
    config.agent ||= {}
    const existing = config.agent[agentName]
    if (existing) {
      if (existing.hidden === true && existing.description === VERIFIER_DESCRIPTION && existing.prompt === VERIFIER_AGENT_PROMPT) return
      throw new Error(`Cannot safely register internal verifier agent ${agentName}: name already exists`)
    }
    config.agent[agentName] = {
      description: VERIFIER_DESCRIPTION,
      mode: "subagent",
      hidden: true,
      prompt: VERIFIER_AGENT_PROMPT,
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
      return "Semantic verifier result accepted."
    },
  })

  async function verify(parentSessionID: string, goal: GoalState): Promise<GoalState> {
    const semantic = goal.requirements.filter((item) => item.required && item.verification === "semantic")
    if (semantic.length === 0) return goal
    const auditToken = randomUUID()
    let childID = ""
    try {
      const created = unwrapData<any>(await client.session.create({ body: { parentID: parentSessionID, title: "Goal verification" } }))
      childID = String(created?.id ?? "")
      if (!childID) throw new Error("OpenCode did not return a verifier session id")
      pending.set(childID, {
        auditToken,
        parentSessionID,
        goalID: goal.id,
        revision: goal.revision,
        expectedRequirementIDs: new Set(semantic.map((item) => item.id)),
      })
      const body = {
        agent: agentName,
        ...(goal.execution?.model ? { model: goal.execution.model } : {}),
        parts: [{ type: "text", text: verificationPrompt(goal, auditToken) }],
      }
      await client.session.prompt({ path: { id: childID }, body })
      const result = submitted.get(childID)
      if (!result || result.auditToken !== auditToken) throw new Error("semantic verifier did not submit a valid result")
      const corroborated = await corroborateEvidence(root, goal, result.results)
      return applySemanticVerifierResults(goal, corroborated)
    } finally {
      if (childID) {
        pending.delete(childID)
        submitted.delete(childID)
        if (client.session.delete) {
          try { await client.session.delete({ path: { id: childID } }) } catch {}
        }
      }
    }
  }

  return { configure, resultTool, verify, get agentName() { return agentName } }
}
