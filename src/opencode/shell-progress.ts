import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import type CorePlugin from "./plugin.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import { isClearlyReadOnlyShellCommand } from "../runtime/cadence.js"
import { isGoalControlPlanePath } from "../runtime/control-plane-path.js"
import { markHostProgress } from "../runtime/progress.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type PendingShell = {
  goalID: string
  revision: number
  command: string
  gitMarker?: string
}

const SHELL_TOOL = "bash"
const MAX_PENDING_SHELL_CALLS = 512
const MAX_SAVE_ATTEMPTS = 3
const execFileAsync = promisify(execFile)

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function callKey(sessionID: unknown, callID: unknown): string | undefined {
  if (typeof sessionID !== "string" || !sessionID || typeof callID !== "string" || !callID) return undefined
  return `${sessionID}\u0000${callID}`
}

function porcelainProjectLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const body = line.length > 3 ? line.slice(3).trim() : line.trim()
      const paths = body.includes(" -> ") ? body.split(" -> ") : [body]
      return paths.some((value) => !isGoalControlPlanePath(value.replace(/^"|"$/g, "")))
    })
    .sort()
}

/**
 * Durable Git worktree marker used to distinguish real shell-driven project
 * progress from read-only diagnostics. Goal/Loop control-plane paths are
 * removed so plugin bookkeeping cannot change this marker.
 */
export async function shellGitWorkspaceMarker(directory: string): Promise<string | undefined> {
  try {
    const [head, status] = await Promise.all([
      execFileAsync("git", ["-C", directory, "rev-parse", "--verify", "HEAD"], { windowsHide: true }),
      execFileAsync("git", ["-C", directory, "status", "--porcelain=v1", "--untracked-files=all"], { windowsHide: true }),
    ])
    const payload = `${String(head.stdout).trim()}\n${porcelainProjectLines(String(status.stdout)).join("\n")}`
    return createHash("sha256").update(payload).digest("hex")
  } catch {
    return undefined
  }
}

export function shellActivityFingerprint(args: any): string | undefined {
  const command = text(args?.command)
  if (!command) return undefined
  const normalized = command.replace(/\r\n/g, "\n").trim()
  if (!normalized) return undefined
  return `shell:${createHash("sha256").update(normalized).digest("hex")}`
}

export function shellProcessExited(output: any): boolean {
  const exit = output?.metadata?.exit
  return typeof exit === "number" && Number.isFinite(exit)
}

/**
 * Count shell work as host-observed progress only when it leaves durable
 * project state behind.
 *
 * In a Git worktree we compare HEAD + porcelain state before/after the shell
 * command, excluding Goal/Loop control-plane files. This prevents repeated
 * curl/grep/test/status probes from resetting the stall guard while preserving
 * generators, moves, commits, and other shell-driven project mutations.
 *
 * Outside Git we keep the historical command-fingerprint fallback for
 * compatibility, but explicitly reject commands the cadence layer can prove
 * read-only. Raw command text is never persisted.
 */
export function installShellProgress(input: PluginInput, hooks: PluginHooks): void {
  const beforeHook = hooks["tool.execute.before"]
  const afterHook = hooks["tool.execute.after"]
  if (typeof beforeHook !== "function" || typeof afterHook !== "function") return

  const store = new GoalStore(input.directory)
  const pending = new Map<string, PendingShell>()

  function remember(key: string, value: PendingShell) {
    pending.set(key, value)
    while (pending.size > MAX_PENDING_SHELL_CALLS) {
      const oldest = pending.keys().next().value
      if (typeof oldest !== "string") break
      pending.delete(oldest)
    }
  }

  hooks["tool.execute.before"] = async (event: any, output?: any) => {
    await beforeHook(event)
    if (event?.tool !== SHELL_TOOL) return

    const key = callKey(event.sessionID, event.callID)
    const command = text(event?.args?.command) ?? text(output?.args?.command)
    if (!key || !command) return

    const goal = await store.load(event.sessionID)
    if (!goal || goal.status !== "active") return
    const gitMarker = await shellGitWorkspaceMarker(input.directory)
    remember(key, {
      goalID: goal.id,
      revision: goal.revision,
      command,
      ...(gitMarker === undefined ? {} : { gitMarker }),
    })
  }

  hooks["tool.execute.after"] = async (event: any, output: any) => {
    await afterHook(event, output)
    if (event?.tool !== SHELL_TOOL) return

    const key = callKey(event.sessionID, event.callID)
    if (!key) return
    const owned = pending.get(key)
    pending.delete(key)
    if (!owned || !shellProcessExited(output)) return

    const afterGitMarker = await shellGitWorkspaceMarker(input.directory)
    let fingerprint: string | undefined
    let summary: string | undefined

    if (owned.gitMarker !== undefined && afterGitMarker !== undefined) {
      if (owned.gitMarker === afterGitMarker) return
      fingerprint = `shell-worktree:${afterGitMarker}`
      summary = "Goal-owned shell command changed the project worktree."
    } else {
      if (isClearlyReadOnlyShellCommand(owned.command)) return
      fingerprint = shellActivityFingerprint({ command: owned.command })
      summary = "Goal-owned shell command completed outside a detectable Git worktree."
    }
    if (!fingerprint) return

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const goal = await store.load(event.sessionID)
      if (!goal || goal.status !== "active" || goal.id !== owned.goalID || goal.revision !== owned.revision) return

      const next = markHostProgress(goal, {
        fingerprint,
        source: "tool:bash",
        summary,
      })
      if (next === goal) return

      try {
        await store.save(next)
        return
      } catch (error) {
        if (!(error instanceof GoalStoreConcurrencyError)) throw error
      }
    }
  }
}
