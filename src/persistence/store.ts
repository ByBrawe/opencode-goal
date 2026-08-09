import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { GoalState } from "../domain/types.js"

export type GoalArchiveReason = "cleared" | "replaced"

export interface GoalArchiveRecord {
  schemaVersion: 1
  goalID: string
  sessionID: string
  reason: GoalArchiveReason
  archivedAt: number
  goal: GoalState
}

export type GoalRestoreResult =
  | { ok: true; goal: GoalState; source: GoalArchiveRecord }
  | { ok: false; reason: "not_found"; matches: [] }
  | { ok: false; reason: "ambiguous"; matches: GoalArchiveRecord[] }
  | { ok: false; reason: "live_unfinished"; current: GoalState }
  | { ok: false; reason: "already_current"; current: GoalState }
  | { ok: false; reason: "completed"; source: GoalArchiveRecord }

function shard(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function validateState(value: unknown): GoalState | null {
  if (!value || typeof value !== "object") return null
  const state = value as Partial<GoalState>
  if (state.schemaVersion !== 1 || typeof state.id !== "string" || typeof state.sessionID !== "string" || typeof state.objective !== "string") return null
  if (!Array.isArray(state.requirements) || !Array.isArray(state.evidence)) return null
  return value as GoalState
}

function validateArchive(value: unknown, sessionID: string): GoalArchiveRecord | null {
  if (!value || typeof value !== "object") return null
  const archive = value as Partial<GoalArchiveRecord>
  if (archive.schemaVersion !== 1 || archive.sessionID !== sessionID || typeof archive.goalID !== "string") return null
  if (archive.reason !== "cleared" && archive.reason !== "replaced") return null
  if (typeof archive.archivedAt !== "number" || !Number.isFinite(archive.archivedAt)) return null
  const goal = validateState(archive.goal)
  if (!goal || goal.sessionID !== sessionID || goal.id !== archive.goalID) return null
  return { ...archive, goal } as GoalArchiveRecord
}

async function readStateFile(file: string): Promise<GoalState | null> {
  try {
    const raw = await fs.readFile(file, "utf8")
    return validateState(JSON.parse(raw))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    throw error
  }
}

async function writeAtomic(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, target)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(String(code)) || attempt >= 5) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
      await fs.rm(target, { force: true }).catch(() => undefined)
    }
  }
}

export class GoalStore {
  readonly root: string
  #locks = new Map<string, Promise<unknown>>()

  constructor(directory: string) {
    this.root = path.join(directory, ".opencode", "goals")
  }

  fileFor(sessionID: string): string {
    return path.join(this.root, `${shard(sessionID)}.json`)
  }

  historyRootFor(sessionID: string): string {
    return path.join(this.root, "history", shard(sessionID))
  }

  archiveFileFor(sessionID: string, goalID: string): string {
    return path.join(this.historyRootFor(sessionID), `${shard(goalID)}.json`)
  }

  async load(sessionID: string): Promise<GoalState | null> {
    return await readStateFile(this.fileFor(sessionID))
  }

  async list(): Promise<GoalState[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.root)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return []
      throw error
    }

    const states: GoalState[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const state = await readStateFile(path.join(this.root, name))
      if (state) states.push(state)
    }
    return states
  }

  async history(sessionID: string, limit = 20): Promise<GoalArchiveRecord[]> {
    const records = await this.#history(sessionID)
    return records.slice(0, Math.max(0, limit))
  }

  async restore(sessionID: string, goalIDPrefix: string, now = Date.now()): Promise<GoalRestoreResult> {
    return await this.#locked(sessionID, async () => {
      const normalized = goalIDPrefix.trim().toLowerCase()
      const records = await this.#history(sessionID)
      const matches = records.filter((record) => record.goalID.toLowerCase().startsWith(normalized))
      if (!matches.length) return { ok: false, reason: "not_found", matches: [] }
      if (matches.length > 1) return { ok: false, reason: "ambiguous", matches }

      const source = matches[0]!
      const current = await readStateFile(this.fileFor(sessionID))
      if (current && current.status !== "completed") return { ok: false, reason: "live_unfinished", current }
      if (current?.id === source.goalID) return { ok: false, reason: "already_current", current }
      if (source.goal.status === "completed") return { ok: false, reason: "completed", source }

      if (current) await this.#archive(current, "replaced")
      const restored: GoalState = {
        ...source.goal,
        status: "paused",
        stopReason: "Restored from goal history. Use /goal resume to continue.",
        updatedAt: now,
      }
      await writeAtomic(this.fileFor(sessionID), restored)
      return { ok: true, goal: restored, source }
    })
  }

  async save(state: GoalState): Promise<void> {
    await this.#locked(state.sessionID, async () => {
      const previous = await readStateFile(this.fileFor(state.sessionID))
      if (previous && previous.id !== state.id) await this.#archive(previous, "replaced")
      await writeAtomic(this.fileFor(state.sessionID), state)
    })
  }

  async clear(sessionID: string): Promise<void> {
    await this.#locked(sessionID, async () => {
      const current = await readStateFile(this.fileFor(sessionID))
      if (current) await this.#archive(current, "cleared")
      await fs.rm(this.fileFor(sessionID), { force: true })
    })
  }

  async #history(sessionID: string): Promise<GoalArchiveRecord[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.historyRootFor(sessionID))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return []
      throw error
    }

    const records: GoalArchiveRecord[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      try {
        const raw = await fs.readFile(path.join(this.historyRootFor(sessionID), name), "utf8")
        const record = validateArchive(JSON.parse(raw), sessionID)
        if (record) records.push(record)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") continue
        throw error
      }
    }
    records.sort((a, b) => b.archivedAt - a.archivedAt || b.goal.updatedAt - a.goal.updatedAt || a.goalID.localeCompare(b.goalID))
    return records
  }

  async #archive(goal: GoalState, reason: GoalArchiveReason, archivedAt = Date.now()): Promise<void> {
    const record: GoalArchiveRecord = {
      schemaVersion: 1,
      goalID: goal.id,
      sessionID: goal.sessionID,
      reason,
      archivedAt,
      goal,
    }
    await writeAtomic(this.archiveFileFor(goal.sessionID, goal.id), record)
  }

  async #locked<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    this.#locks.set(sessionID, next)
    try {
      return await next
    } finally {
      if (this.#locks.get(sessionID) === next) this.#locks.delete(sessionID)
    }
  }
}
