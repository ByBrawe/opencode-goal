import type { GoalState } from "../domain/types.js"
import { continuationPrompt } from "../opencode/prompt.js"
import {
  openCode2ExecutionSessionID,
  openCode2ExecutionTerminal,
  type OpenCode2ExecutionTerminal,
} from "./execution-boundary.js"

type CompactionObservation = {
  ended: boolean
  executionSucceeded: boolean
}

export interface OpenCode2CompactionBoundaryRuntime {
  sessions: Map<string, CompactionObservation>
}

export interface OpenCode2CompactionBoundaryResult {
  sessionID?: string
  recognized: boolean
  consumedExecution: boolean
  compactionCompleted: boolean
  compactionFailed: boolean
  terminal?: OpenCode2ExecutionTerminal
}

export function createOpenCode2CompactionBoundaryRuntime(): OpenCode2CompactionBoundaryRuntime {
  return { sessions: new Map() }
}

export function observeOpenCode2CompactionBoundary(
  runtime: OpenCode2CompactionBoundaryRuntime,
  event: unknown,
): OpenCode2CompactionBoundaryResult {
  const type = typeof (event as any)?.type === "string" ? String((event as any).type) : ""
  const sessionID = openCode2ExecutionSessionID(event)
  const terminal = openCode2ExecutionTerminal(event)

  if (!sessionID) {
    return { recognized: false, consumedExecution: false, compactionCompleted: false, compactionFailed: false }
  }

  if (type === "session.compaction.started") {
    runtime.sessions.set(sessionID, { ended: false, executionSucceeded: false })
    return {
      sessionID,
      recognized: true,
      consumedExecution: false,
      compactionCompleted: false,
      compactionFailed: false,
    }
  }

  const state = runtime.sessions.get(sessionID)
  if (!state) {
    return {
      sessionID,
      recognized: false,
      consumedExecution: false,
      compactionCompleted: false,
      compactionFailed: false,
      ...(terminal ? { terminal } : {}),
    }
  }

  if (type === "session.compaction.ended") {
    state.ended = true
    if (state.executionSucceeded) {
      runtime.sessions.delete(sessionID)
      return {
        sessionID,
        recognized: true,
        consumedExecution: false,
        compactionCompleted: true,
        compactionFailed: false,
      }
    }
    return {
      sessionID,
      recognized: true,
      consumedExecution: false,
      compactionCompleted: false,
      compactionFailed: false,
    }
  }

  if (type === "session.compaction.failed") {
    runtime.sessions.delete(sessionID)
    return {
      sessionID,
      recognized: true,
      consumedExecution: false,
      compactionCompleted: false,
      compactionFailed: true,
    }
  }

  if (terminal === "succeeded") {
    state.executionSucceeded = true
    if (state.ended) runtime.sessions.delete(sessionID)
    return {
      sessionID,
      recognized: true,
      consumedExecution: true,
      compactionCompleted: state.ended,
      compactionFailed: false,
      terminal,
    }
  }

  if (terminal === "failed" || terminal === "interrupted") {
    runtime.sessions.delete(sessionID)
    return {
      sessionID,
      recognized: true,
      consumedExecution: true,
      compactionCompleted: false,
      compactionFailed: true,
      terminal,
    }
  }

  return {
    sessionID,
    recognized: true,
    consumedExecution: false,
    compactionCompleted: false,
    compactionFailed: false,
  }
}

export function prepareOpenCode2PostCompactionContinuation(goal: GoalState): {
  goal: GoalState
  shouldContinue: boolean
  prompt?: string
} {
  if (goal.status !== "active") return { goal, shouldContinue: false }
  return {
    goal,
    shouldContinue: true,
    prompt: continuationPrompt(goal),
  }
}
