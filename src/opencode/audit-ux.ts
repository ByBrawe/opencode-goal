import type CorePlugin from "./plugin.js"
import type { EvidenceRecord, GoalRequirement, GoalState } from "../domain/types.js"
import { GoalStore } from "../persistence/store.js"
import { formatGoalBudget } from "../runtime/accounting.js"
import { formatTodoPlan } from "../runtime/todo-plan.js"
import { auditCompletion } from "../verification/audit.js"
import { parseGoalCommand } from "./command.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>
type PromptTranslation = { shown: string; owned: string }

function textFromParts(parts: any[]): string {
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}

function replaceParts(parts: any[], text: string) {
  parts.splice(0, parts.length, { type: "text", text })
}

function shortID(value: string): string {
  return value.slice(0, 12)
}

function requirementSource(requirement: GoalRequirement): string {
  return requirement.source ?? requirement.verification
}

function requirementLine(requirement: GoalRequirement, index: number): string {
  const required = requirement.required ? "required" : "optional"
  const evidence = requirement.evidenceIDs.length ? requirement.evidenceIDs.map(shortID).join(", ") : "none"
  return `${index + 1}. [${requirement.status}; ${required}; ${requirementSource(requirement)}/${requirement.verification}] ${requirement.text}\n   Evidence refs: ${evidence}`
}

function evidenceLine(goal: GoalState, evidence: EvidenceRecord): string {
  const verdict = evidence.passed === true ? "PASS" : evidence.passed === false ? "FAIL" : "INFO"
  const revision = evidence.goalRevision === goal.revision ? `current r${evidence.goalRevision}` : `STALE r${evidence.goalRevision}`
  const requirements = evidence.requirementIDs.length ? evidence.requirementIDs.map(shortID).join(",") : "none"
  const source = evidence.source ? ` source:${evidence.source}` : ""
  return `- ${shortID(evidence.id)} [${verdict} ${evidence.trust}/${evidence.kind}; ${revision}; req:${requirements}] ${new Date(evidence.createdAt).toISOString()}${source} — ${evidence.summary}`
}

function executionLine(goal: GoalState): string {
  if (!goal.execution) return "unbound"
  const parts = []
  if (goal.execution.agent) parts.push(`agent=${goal.execution.agent}`)
  if (goal.execution.model) parts.push(`model=${goal.execution.model.providerID}/${goal.execution.model.modelID}`)
  if (goal.execution.variant) parts.push(`variant=${goal.execution.variant}`)
  return parts.length ? parts.join(" | ") : "unbound"
}

function gateSection(goal: GoalState): string {
  if (goal.status === "completed") {
    const summary = goal.completionSummary ? `\nCompletion summary: ${goal.completionSummary}` : ""
    return `Completion gate: COMPLETED${summary}`
  }

  const audit = auditCompletion(goal)
  if (audit.ok) return "Completion gate: READY\nGate reasons:\n- none"
  return `Completion gate: NOT READY\nGate reasons:\n${audit.reasons.map((reason) => `- ${reason}`).join("\n")}`
}

export function formatGoalAudit(goal: GoalState | null): string {
  if (!goal) return "No active goal audit."

  const requirements = goal.requirements.length
    ? goal.requirements.map(requirementLine).join("\n")
    : "- none"
  const evidence = goal.evidence.length
    ? [...goal.evidence].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)).map((item) => evidenceLine(goal, item)).join("\n")
    : "- none"
  const stop = goal.stopReason ? `\nStop reason: ${goal.stopReason}` : ""
  const blocker = goal.blockerAudit
    ? `\nBlocker: ${goal.blockerAudit.reason} | needed: ${goal.blockerAudit.needed} | consecutive turns: ${goal.blockerAudit.consecutiveTurns}`
    : ""

  return `Goal Audit\nGoal ID: ${goal.id}\nSession: ${goal.sessionID}\nObjective: ${goal.objective}\nStatus: ${goal.status}\nRevision: ${goal.revision}\nStorage generation: ${goal.storageGeneration ?? 0}\nExecution: ${executionLine(goal)}\nBudget / usage: ${formatGoalBudget(goal)}\nProgress revisions: observed ${goal.observedProgressRevision} / claimed ${goal.progressRevision}\nNative Todo plan: ${formatTodoPlan(goal)} (advisory; never completion evidence)\nStalled turns: ${goal.stalledTurns}${stop}${blocker}\n\n${gateSection(goal)}\n\nRequirement ledger:\n${requirements}\n\nEvidence records:\n${evidence}\n\nThis is a read-only snapshot. It does not run checks, invoke the verifier, or mutate Goal state.`
}

export function installGoalAuditUX(input: PluginInput, hooks: PluginHooks): void {
  const store = new GoalStore(input.directory)
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const translations = new Map<string, PromptTranslation>()

  hooks["command.execute.before"] = async (event: any, output: any) => {
    if (event.command !== "goal") {
      await commandHook(event, output)
      return
    }

    const parsed = parseGoalCommand(event.arguments ?? "")
    if (parsed.action !== "audit") {
      await commandHook(event, output)
      return
    }

    // Reuse the lower read-only status path only to seed command ownership.
    // The audit itself performs no verification and no Goal mutation.
    await commandHook({ ...event, arguments: "status" }, output)
    const ownedText = textFromParts(output.parts)
    const shown = `${formatGoalAudit(await store.load(event.sessionID))}\nRespond with this Goal audit only; do not perform work.`
    replaceParts(output.parts, shown)
    translations.set(event.sessionID, { shown, owned: ownedText })
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const translation = translations.get(event.sessionID)
    if (!translation) {
      await chatHook(event, output)
      return
    }

    translations.delete(event.sessionID)
    const shown = textFromParts(output?.parts ?? [])
    if (shown !== translation.shown) {
      await chatHook(event, output)
      return
    }

    await chatHook(event, {
      ...output,
      parts: [{ type: "text", text: translation.owned }],
    })
  }
}
