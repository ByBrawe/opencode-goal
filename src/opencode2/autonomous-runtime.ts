import type { GoalState } from "../domain/types.js"

export type OpenCode2GoalContinuationSource = "execution" | "compaction" | "restart" | "kickoff"

export interface OpenCode2GoalPromptOwner {
  messageID: string
  goalID: string
  revision: number
  source: OpenCode2GoalContinuationSource
}

export interface OpenCode2GoalExecutionOwner extends OpenCode2GoalPromptOwner {
  generation: number
}

export interface OpenCode2GoalKickoffOwner {
  goalID: string
  revision: number
  generation: number
}

export interface OpenCode2AutonomousRuntime {
  pendingPromptBySession: Map<string, OpenCode2GoalPromptOwner>
  executionOwnerBySession: Map<string, OpenCode2GoalExecutionOwner>
  kickoffBySession: Map<string, OpenCode2GoalKickoffOwner>
}

export function createOpenCode2AutonomousRuntime(): OpenCode2AutonomousRuntime {
  return {
    pendingPromptBySession: new Map(),
    executionOwnerBySession: new Map(),
    kickoffBySession: new Map(),
  }
}

export function rememberOpenCode2GoalPrompt(
  runtime: OpenCode2AutonomousRuntime,
  sessionID: string,
  messageID: string,
  goal: Pick<GoalState, "id" | "revision">,
  source: OpenCode2GoalContinuationSource,
): void {
  runtime.pendingPromptBySession.set(sessionID, {
    messageID,
    goalID: goal.id,
    revision: goal.revision,
    source,
  })
}

export function forgetOpenCode2GoalPrompt(
  runtime: OpenCode2AutonomousRuntime,
  sessionID: string,
  messageID: string,
): void {
  const pending = runtime.pendingPromptBySession.get(sessionID)
  if (pending?.messageID === messageID) runtime.pendingPromptBySession.delete(sessionID)
}

export function armOpenCode2GoalExecution(
  runtime: OpenCode2AutonomousRuntime,
  sessionID: string,
  lastUserMessageID: string | undefined,
  generation: number,
): OpenCode2GoalExecutionOwner | undefined {
  if (!lastUserMessageID || generation <= 0) return undefined
  const pending = runtime.pendingPromptBySession.get(sessionID)
  if (!pending || pending.messageID !== lastUserMessageID) return undefined
  const owner: OpenCode2GoalExecutionOwner = { ...pending, generation }
  runtime.pendingPromptBySession.delete(sessionID)
  runtime.executionOwnerBySession.set(sessionID, owner)
  return owner
}

export function consumeOpenCode2GoalExecution(
  runtime: OpenCode2AutonomousRuntime,
  sessionID: string,
  generation: number,
): OpenCode2GoalExecutionOwner | undefined {
  const owner = runtime.executionOwnerBySession.get(sessionID)
  if (!owner || owner.generation !== generation) return undefined
  runtime.executionOwnerBySession.delete(sessionID)
  return owner
}

export function rememberOpenCode2GoalKickoff(
  runtime: OpenCode2AutonomousRuntime,
  sessionID: string,
  generation: number,
  goal: Pick<GoalState, "id" | "revision">,
): void {
  runtime.kickoffBySession.set(sessionID, {
    goalID: goal.id,
    revision: goal.revision,
    generation,
  })
}

export function consumeOpenCode2GoalKickoff(
  runtime: OpenCode2AutonomousRuntime,
  sessionID: string,
  generation: number,
): OpenCode2GoalKickoffOwner | undefined {
  const owner = runtime.kickoffBySession.get(sessionID)
  if (!owner || owner.generation !== generation) return undefined
  runtime.kickoffBySession.delete(sessionID)
  return owner
}

export function clearOpenCode2GoalOwnership(runtime: OpenCode2AutonomousRuntime, sessionID: string): void {
  runtime.pendingPromptBySession.delete(sessionID)
  runtime.executionOwnerBySession.delete(sessionID)
  runtime.kickoffBySession.delete(sessionID)
}
