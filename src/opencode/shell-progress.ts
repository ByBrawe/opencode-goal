import { createHash } from "node:crypto"
import type CorePlugin from "./plugin.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import { markHostProgress } from "../runtime/progress.js"
import {
  beginWorkspaceMutationWatch,
  type WorkspaceMutationWatch,
} from "../runtime/workspace-mutation-watch.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type PendingShell = {
  goalID: string
  revision: number
  watcher: WorkspaceMutationWatch | null
}

const SHELL_TOOL = "bash"
const MAX_PENDING_SHELL_CALLS = 512
const MAX_SAVE_ATTEMPTS = 3

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function callKey(sessionID: unknown, callID: unknown): string | undefined {
  if (typeof sessionID !== "string" || !sessionID || typeof callID !== "string" || !callID) return undefined
  return `${sessionID}\u0000${callID}`
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

function shellResultFingerprint(args: any, output: any, workspaceFingerprint?: string): string | undefined {
  if (!shellProcessExited(output)) return undefined
  const activity = shellActivityFingerprint(args)
  if (!activity) return undefined
  return `shell-result:${createHash("sha256")
    .update(activity)
    .update("\0")
    .update(String(output.metadata.exit))
    .update("\0")
    .update(workspaceFingerprint ?? "")
    .digest("hex")}`
}

/**
 * Count completed, Goal-revision-bound shell work as host-observed progress.
 *
 * The core plugin still owns shell safety/cadence and completion evidence. This
 * wrapper only feeds the no-progress guard. It combines a secret-safe hash of
 * command + numeric exit with a bounded project-local filesystem watcher. The
 * same command/exit therefore counts again only when its final workspace state
 * changes. Volatile stdout/stderr is deliberately excluded so timestamp/log
 * noise cannot manufacture progress. Raw command/output/path values are never
 * persisted.
 *
 * OpenCode 1.4.0+ reports a numeric metadata.exit when the shell process really
 * exits and null when the tool is aborted or times out. Incomplete executions
 * never mark shell progress, even if they emitted filesystem events before the
 * abort/timeout boundary.
 */
export function installShellProgress(input: PluginInput, hooks: PluginHooks): void {
  const beforeHook = hooks["tool.execute.before"]
  const afterHook = hooks["tool.execute.after"]
  if (typeof beforeHook !== "function" || typeof afterHook !== "function") return

  const store = new GoalStore(input.directory)
  const pending = new Map<string, PendingShell>()

  function dispose(value: PendingShell | undefined) {
    value?.watcher?.dispose()
  }

  function remember(key: string, value: PendingShell) {
    dispose(pending.get(key))
    pending.set(key, value)
    while (pending.size > MAX_PENDING_SHELL_CALLS) {
      const oldest = pending.keys().next().value
      if (typeof oldest !== "string") break
      dispose(pending.get(oldest))
      pending.delete(oldest)
    }
  }

  hooks["tool.execute.before"] = async (event: any) => {
    await beforeHook(event)
    if (event?.tool !== SHELL_TOOL) return

    const key = callKey(event.sessionID, event.callID)
    if (!key) return

    const goal = await store.load(event.sessionID)
    if (!goal || goal.status !== "active") return
    const watcher = await beginWorkspaceMutationWatch(input.directory).catch(() => null)
    remember(key, { goalID: goal.id, revision: goal.revision, watcher })
  }

  hooks["tool.execute.after"] = async (event: any, output: any) => {
    const shellKey = event?.tool === SHELL_TOOL ? callKey(event.sessionID, event.callID) : undefined
    const owned = shellKey ? pending.get(shellKey) : undefined
    if (shellKey) pending.delete(shellKey)

    try {
      await afterHook(event, output)
    } catch (error) {
      dispose(owned)
      throw error
    }

    if (event?.tool !== SHELL_TOOL || !owned) return

    let workspaceFingerprint: string | undefined
    try {
      workspaceFingerprint = (await owned.watcher?.finish())?.fingerprint
    } catch {
      dispose(owned)
    }

    const fingerprint = shellResultFingerprint(event.args, output, workspaceFingerprint)
    if (!fingerprint) return

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const goal = await store.load(event.sessionID)
      if (!goal || goal.status !== "active" || goal.id !== owned.goalID || goal.revision !== owned.revision) return

      const next = markHostProgress(goal, {
        fingerprint,
        source: "tool:bash",
        summary: "Goal-owned shell command completed with a new host-observed result.",
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
