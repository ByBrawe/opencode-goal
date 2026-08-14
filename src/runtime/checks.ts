import { spawn } from "node:child_process"
import type { GoalState } from "../domain/types.js"
import { proveRequirementsFromEvidence, recordCommandEvidence } from "../verification/evidence.js"

export const DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS = 60 * 60_000

function configuredCheckTimeoutMs(explicit?: number): number {
  if (Number.isFinite(explicit) && Number(explicit) > 0) return Number(explicit)
  const env = Number(process.env.OPENCODE_GOAL_CHECK_TIMEOUT_MS)
  if (Number.isFinite(env) && env > 0) return env
  return DEFAULT_CONFIGURED_CHECK_TIMEOUT_MS
}

function run(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env })
    let output = ""
    const append = (chunk: Buffer | string) => { output = (output + String(chunk)).slice(-64_000) }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.on("error", (error: Error) => {
      clearTimeout(timer)
      resolve({ code: 1, output: `${output}\n${error.message}` })
    })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      resolve({ code: typeof code === "number" ? code : 1, output })
    })
  })
}

export async function runConfiguredChecks(goal: GoalState, cwd: string, options: { timeoutMs?: number } = {}): Promise<GoalState> {
  const timeoutMs = configuredCheckTimeoutMs(options.timeoutMs)
  let next = goal
  for (const requirement of next.requirements.filter((item) => item.verification === "command" && item.command)) {
    const result = await run(requirement.command!, cwd, timeoutMs)
    next = recordCommandEvidence(next, {
      command: requirement.command!,
      exitCode: result.code,
      output: result.output,
      requirementIDs: [requirement.id],
    })
    const evidence = next.evidence.at(-1)!
    if (result.code === 0) next = proveRequirementsFromEvidence(next, evidence.id)
    else {
      next = {
        ...next,
        requirements: next.requirements.map((item) => item.id === requirement.id ? { ...item, status: "failed" as const, updatedAt: Date.now() } : item),
      }
    }
  }
  return next
}
