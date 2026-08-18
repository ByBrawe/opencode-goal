import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { EvidenceRecord, GoalRequirement, GoalState } from "../domain/types.js"

function assertInside(root: string, candidate: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(base, candidate)
  const relative = path.relative(base, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("evidence path escapes the project root")
  return resolved
}

function addEvidence(goal: GoalState, evidence: EvidenceRecord): GoalState {
  return {
    ...goal,
    evidence: [...goal.evidence, evidence].slice(-500),
    progressRevision: evidence.trust === "agent" ? goal.progressRevision : goal.progressRevision + 1,
    updatedAt: evidence.createdAt,
  }
}

function resolveRequirement(goal: GoalState, selector: string): GoalRequirement | undefined {
  const trimmed = selector.trim()
  const exact = goal.requirements.find((item) => item.id === trimmed)
  if (exact) return exact
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined
  return goal.requirements[Number(trimmed) - 1]
}

export function recordAgentNote(goal: GoalState, input: { summary: string; requirementIDs?: string[]; now?: number }): GoalState {
  const now = input.now ?? Date.now()
  return addEvidence(goal, {
    id: randomUUID(),
    kind: "agent_note",
    trust: "agent",
    summary: input.summary.trim(),
    createdAt: now,
    goalRevision: goal.revision,
    requirementIDs: input.requirementIDs ?? [],
  })
}

export function recordCommandEvidence(goal: GoalState, input: {
  command: string
  exitCode: number
  output: string
  requirementIDs?: string[]
  now?: number
}): GoalState {
  const now = input.now ?? Date.now()
  const outputDigest = createHash("sha256").update(input.output).digest("hex")
  return addEvidence(goal, {
    id: randomUUID(),
    kind: "command",
    trust: "host",
    summary: `${input.command} exited ${input.exitCode}`,
    createdAt: now,
    goalRevision: goal.revision,
    requirementIDs: input.requirementIDs ?? [],
    source: input.command,
    passed: input.exitCode === 0,
    metadata: { exitCode: input.exitCode, outputSha256: outputDigest },
  })
}

export async function recordFileEvidence(goal: GoalState, input: {
  root: string
  requirementID: string
  now?: number
}): Promise<{ goal: GoalState; evidence: EvidenceRecord }> {
  const requirement = resolveRequirement(goal, input.requirementID)
  if (!requirement) throw new Error("requirement not found")
  if (requirement.verification !== "file" || !requirement.file) {
    throw new Error("requirement does not have a host-verifiable file contract")
  }
  const now = input.now ?? Date.now()
  const absolute = assertInside(input.root, requirement.file)
  let content = ""
  let exists = true
  try {
    content = await fs.readFile(absolute, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw error
    exists = false
  }
  const passed = exists && (requirement.contains === undefined || content.includes(requirement.contains))
  const digest = exists ? createHash("sha256").update(content).digest("hex") : ""
  const evidence: EvidenceRecord = {
    id: randomUUID(),
    kind: "file",
    trust: "host",
    summary: passed
      ? `Verified ${requirement.file}${requirement.contains === undefined ? " exists" : " contains the required text"}`
      : `Could not verify ${requirement.file}${requirement.contains === undefined ? " exists" : " contains the required text"}`,
    createdAt: now,
    goalRevision: goal.revision,
    requirementIDs: [requirement.id],
    source: requirement.file,
    passed,
    metadata: { exists, sha256: digest, ...(requirement.contains === undefined ? {} : { contains: requirement.contains }) },
  }
  return { goal: addEvidence(goal, evidence), evidence }
}

export function proveRequirementsFromEvidence(goal: GoalState, evidenceID: string, now = Date.now()): GoalState {
  const evidence = goal.evidence.find((item) => item.id === evidenceID)
  if (!evidence) throw new Error("evidence not found")
  if (evidence.goalRevision !== goal.revision) throw new Error("stale evidence cannot prove the current goal revision")
  if (evidence.trust === "agent") throw new Error("agent-authored evidence cannot prove a requirement")
  if (evidence.passed === false) throw new Error("failed evidence cannot prove a requirement")
  if (evidence.requirementIDs.length === 0) throw new Error("evidence is not linked to a requirement")

  let changed = false
  const requirements = goal.requirements.map((item) => {
    if (!evidence.requirementIDs.includes(item.id)) return item
    const contractMatches =
      (item.verification === "command" && evidence.kind === "command" && evidence.source === item.command) ||
      (item.verification === "file" && evidence.kind === "file" && evidence.source === item.file)
    if (!contractMatches) throw new Error(`evidence does not satisfy verification contract for requirement: ${item.text}`)
    changed = true
    return { ...item, status: "proven" as const, evidenceIDs: [...new Set([...item.evidenceIDs, evidence.id])], updatedAt: now }
  })
  if (!changed) throw new Error("evidence does not reference a current requirement")
  return { ...goal, requirements, progressRevision: goal.progressRevision + 1, updatedAt: now }
}
