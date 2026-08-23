import { randomUUID } from "node:crypto"
import type CorePlugin from "./plugin.js"
import { GoalStore } from "../persistence/store.js"

type PluginInput = Parameters<typeof CorePlugin>[0]
type PluginHooks = Awaited<ReturnType<typeof CorePlugin>>

const FOREIGN_COMMAND_MARKER_PREFIX = "opencode-goal:foreign-command:"
const FOREIGN_COMMAND_MARKER_RETENTION_MS = 10 * 60_000
const FOREIGN_COMMAND_MARKER_RE = /\n?<!-- opencode-goal:foreign-command:([A-Za-z0-9-]+) -->/g

function commandName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function appendMarker(parts: any[], token: string): boolean {
  if (!Array.isArray(parts)) return false
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.type !== "text" || typeof part.text !== "string") continue
    part.text = `${part.text}\n<!-- ${FOREIGN_COMMAND_MARKER_PREFIX}${token} -->`
    return true
  }
  return false
}

/**
 * OpenCode 1.x can still materialize a slash command as a synthetic user/model
 * turn even when another plugin handles that command and sets noReply. While a
 * Goal is persisted, that synthetic turn must not be mistaken for foreground
 * human steering or repin the Goal executor to the command's local agent/model.
 *
 * The command hook therefore adds a one-time random HTML-comment marker to the
 * concrete command prompt. The matching chat hook removes only markers issued
 * by this plugin instance and skips the core steering hook for that one message.
 * Unknown/spoofed markers remain ordinary chat. Outer Goal wrappers still run,
 * because this guard is installed immediately above the core plugin.
 */
export function installForeignCommandSteeringGuard(input: PluginInput, hooks: PluginHooks): void {
  const commandHook = hooks["command.execute.before"]
  const chatHook = hooks["chat.message"]
  if (typeof commandHook !== "function" || typeof chatHook !== "function") return

  const store = new GoalStore(input.directory)
  const markers = new Map<string, Map<string, number>>()

  function markerMap(sessionID: string): Map<string, number> {
    const current = markers.get(sessionID) ?? new Map<string, number>()
    const now = Date.now()
    for (const [token, expiresAt] of current.entries()) {
      if (expiresAt < now) current.delete(token)
    }
    if (!markers.has(sessionID)) markers.set(sessionID, current)
    return current
  }

  function rememberMarker(sessionID: string, token: string): void {
    markerMap(sessionID).set(token, Date.now() + FOREIGN_COMMAND_MARKER_RETENTION_MS)
  }

  function consumeMarker(sessionID: string, token: string): boolean {
    const current = markerMap(sessionID)
    const expiresAt = current.get(token)
    if (!expiresAt || expiresAt < Date.now()) return false
    current.delete(token)
    if (current.size === 0) markers.delete(sessionID)
    return true
  }

  function stripOwnedMarkers(sessionID: string, parts: any[]): boolean {
    if (!Array.isArray(parts)) return false
    let owned = false
    for (const part of parts) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      part.text = part.text.replace(FOREIGN_COMMAND_MARKER_RE, (full: string, token: string) => {
        if (!consumeMarker(sessionID, token)) return full
        owned = true
        return ""
      })
    }
    return owned
  }

  hooks["command.execute.before"] = async (event: any, output: any) => {
    await commandHook(event, output)
    const name = commandName(event?.command)
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
    if (!sessionID || !name || name === "goal") return

    // Foreign command compatibility must never make an unrelated slash command
    // fail just because Goal persistence is unavailable. Core Goal operations
    // remain fail-closed through their normal paths.
    let goal
    try {
      goal = await store.load(sessionID)
    } catch {
      return
    }
    if (!goal || goal.status === "completed") return

    const token = randomUUID()
    if (!appendMarker(output?.parts, token)) return
    rememberMarker(sessionID, token)
  }

  hooks["chat.message"] = async (event: any, output: any) => {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
    if (sessionID && stripOwnedMarkers(sessionID, output?.parts ?? [])) return
    await chatHook(event, output)
  }
}
