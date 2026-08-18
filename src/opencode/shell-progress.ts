import { createHash } from "node:crypto"
import type CorePlugin from "./plugin.js"
import { GoalStore, GoalStoreConcurrencyError } from "../persistence/store.js"
import { markHostProgress } from "../runtime/progress.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

type PendingShell = {
  goalID: string
  revision: number
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

/**
 * Count completed, Goal-revision-bound shell actions as host-observed progress.
 *
 * The core plugin already owns shell safety/cadence. This wrapper only feeds the
 * no-progress guard so real work performed through `bash` is not mistaken for a
 * stalled turn. Raw command text is never persisted; only a SHA-256 fingerprint
 * and a generic progress note are stored. Repeating the exact same command is
 * therefore a no-op for progress accounting.
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

  hooks["tool.execute.before"] = async (event: any) => {
    await beforeHook(event)
    if (event?.tool !== SHELL_TOOL) return

    const key = callKey(event.sessionID, event.callID)
    if (!key) return

    const goal = await store.load(event.sessionID)
    if (!goal || goal.status !== "active") return
    remember(key, { goalID: goal.id, revision: goal.revision })
  }

  hooks["tool.execute.after"] = async (event: any, output: any) => {
    await afterHook(event, output)
    if (event?.tool !== SHELL_TOOL) return

    const key = callKey(event.sessionID, event.callID)
    if (!key) return
    const owned = pending.get(key)
    pending.delete(key)
    if (!owned) return

    const fingerprint = shellActivityFingerprint(event.args)
    if (!fingerprint) return

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const goal = await store.load(event.sessionID)
      if (!goal || goal.status !== "active" || goal.id !== owned.goalID || goal.revision !== owned.revision) return

      const next = markHostProgress(goal, {
        fingerprint,
        source: "tool:bash",
        summary: "Goal-owned shell command completed.",
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
