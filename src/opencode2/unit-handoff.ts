import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import type { GoalState, GoalUnitRotation } from "../domain/types.js"

export const DEFAULT_UNIT_COMMAND_TIMEOUT_MS = 10_000
export const MAX_UNIT_IDENTITY_CHARS = 4_096

function normalizedUnitIdentity(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim()
  if (!normalized) throw new Error("unit command produced empty stdout")
  if (normalized.length > MAX_UNIT_IDENTITY_CHARS) {
    throw new Error(`unit command stdout exceeds ${MAX_UNIT_IDENTITY_CHARS} characters`)
  }
  return normalized
}

export function unitIdentityDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function readGoalUnitIdentity(
  command: string,
  directory: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNIT_COMMAND_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("unit command timeout must be positive")
  const normalizedCommand = command.trim()
  if (!normalizedCommand) throw new Error("unit command must not be empty")

  return await new Promise((resolve, reject) => {
    const child = spawn(normalizedCommand, {
      cwd: directory,
      shell: true,
      env: process.env,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const appendOut = (chunk: Buffer | string) => { stdout = (stdout + String(chunk)).slice(-16_384) }
    const appendErr = (chunk: Buffer | string) => { stderr = (stderr + String(chunk)).slice(-16_384) }
    child.stdout?.on("data", appendOut)
    child.stderr?.on("data", appendErr)

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`unit command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    ;(timer as any).unref?.()

    child.once("error", (error) => finish(error))
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`unit command failed (${code ?? signal ?? "unknown"}): ${stderr.trim() || "no stderr"}`))
        return
      }
      try {
        resolve(normalizedUnitIdentity(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export function observeInitialGoalUnit(goal: GoalState, unit: string, now = Date.now()): GoalState {
  if (!goal.unitRotation) return goal
  if (goal.unitRotation.currentUnit === unit) return goal
  if (goal.unitRotation.currentUnit !== undefined) return goal
  return {
    ...goal,
    unitRotation: {
      ...goal.unitRotation,
      currentUnit: unit,
      observedAt: now,
    },
    updatedAt: now,
  }
}

export function unitRotationNeeded(goal: GoalState, unit: string): boolean {
  return Boolean(
    goal.status === "active"
    && goal.unitRotation?.freshSessionPerUnit
    && goal.unitRotation.currentUnit !== undefined
    && goal.unitRotation.currentUnit !== unit,
  )
}

function baseRotation(goal: GoalState): GoalUnitRotation {
  const rotation = goal.unitRotation
  if (!rotation) throw new Error("goal has no unit rotation contract")
  return rotation
}

export function createUnitHandoffTarget(
  source: GoalState,
  targetSessionID: string,
  nextUnit: string,
  now = Date.now(),
): GoalState {
  const rotation = baseRotation(source)
  const messageID = `goal-handoff-${randomUUID()}`
  return {
    ...source,
    sessionID: targetSessionID,
    status: "handoff_pending",
    stopReason: "Prepared bounded-session handoff; source session still owns continuation until terminal handoff is persisted.",
    pendingContinuation: true,
    storageGeneration: 0,
    unitRotation: {
      command: rotation.command,
      freshSessionPerUnit: true,
      currentUnit: nextUnit,
      observedAt: now,
      rootSessionID: rotation.rootSessionID,
      chainIndex: rotation.chainIndex + 1,
      previousSessionID: source.sessionID,
      handoff: {
        fromSessionID: source.sessionID,
        toSessionID: targetSessionID,
        ...(rotation.currentUnit !== undefined ? { fromUnit: rotation.currentUnit } : {}),
        toUnit: nextUnit,
        phase: "prepared",
        createdAt: now,
        messageID,
      } as GoalUnitRotation["handoff"] & { messageID: string },
    },
    updatedAt: now,
  }
}

export function markUnitHandoffSourceTerminal(
  source: GoalState,
  target: GoalState,
  now = Date.now(),
): GoalState {
  if (!source.unitRotation || !target.unitRotation?.handoff) throw new Error("unit handoff state is incomplete")
  return {
    ...source,
    status: "handed_off",
    stopReason: `Goal ownership handed off to session ${target.sessionID} for unit ${JSON.stringify(target.unitRotation.currentUnit)}.`,
    pendingContinuation: undefined,
    unitRotation: {
      ...source.unitRotation,
      nextSessionID: target.sessionID,
      handoff: {
        ...target.unitRotation.handoff,
        phase: "source_terminal",
      },
    },
    updatedAt: now,
  }
}

export function activateUnitHandoffTarget(target: GoalState, now = Date.now()): GoalState {
  const handoff = target.unitRotation?.handoff
  if (!handoff) throw new Error("unit handoff target has no durable handoff marker")
  if (target.status !== "handoff_pending") return target
  const { stopReason: _stopReason, ...rest } = target
  return {
    ...rest,
    status: "active",
    pendingContinuation: true,
    unitRotation: {
      ...target.unitRotation!,
      handoff: {
        ...handoff,
        phase: "dispatch_pending",
      },
    },
    updatedAt: now,
  }
}

export function unitHandoffMessageID(goal: GoalState): string | undefined {
  const value = (goal.unitRotation?.handoff as (GoalUnitRotation["handoff"] & { messageID?: string }) | undefined)?.messageID
  return typeof value === "string" && value.trim() ? value : undefined
}

export function markUnitHandoffDispatched(goal: GoalState, now = Date.now()): GoalState {
  const handoff = goal.unitRotation?.handoff
  if (!handoff) return goal
  const { pendingContinuation: _pendingContinuation, ...rest } = goal
  return {
    ...rest,
    unitRotation: {
      ...goal.unitRotation!,
      handoff: {
        ...handoff,
        phase: "dispatched",
        dispatchedAt: now,
      },
    },
    updatedAt: now,
  }
}
