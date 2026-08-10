import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { GoalState } from "../domain/types.js"
import { acquireGoalStoreProcessLock, GoalStoreConcurrencyError } from "./process-lock.js"

export { GoalStoreConcurrencyError }
export type { GoalStoreConcurrencyKind } from "./process-lock.js"

export type GoalArchiveReason = "cleared" | "replaced"
export type GoalStoreIntegrityKind = "invalid_json" | "invalid_state" | "invalid_archive" | "unsafe_path"

export class GoalStoreIntegrityError extends Error {
  readonly code = "GOAL_STORE_INTEGRITY"

  constructor(
    readonly file: string,
    readonly kind: GoalStoreIntegrityKind,
    detail: string,
  ) {
    super(`Goal storage integrity error (${kind}) at ${file}: ${detail}`)
    this.name = "GoalStoreIntegrityError"
  }
}

export interface GoalArchiveRecord {
  schemaVersion: 1
  goalID: string
  sessionID: string
  reason: GoalArchiveReason
  archivedAt: number
  goal: GoalState
}

export interface GoalHistoryPruneResult {
  keep: number
  kept: GoalArchiveRecord[]
  removed: GoalArchiveRecord[]
}

export type GoalRestoreResult =
  | { ok: true; goal: GoalState; source: GoalArchiveRecord }
  | { ok: false; reason: "not_found"; matches: [] }
  | { ok: false; reason: "ambiguous"; matches: GoalArchiveRecord[] }
  | { ok: false; reason: "live_unfinished"; current: GoalState }
  | { ok: false; reason: "already_current"; current: GoalState }
  | { ok: false; reason: "completed"; source: GoalArchiveRecord }

export interface GoalStoreOptions {
  processLockTimeoutMs?: number
}

function shard(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function validGeneration(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0)
}

function storageGeneration(goal: GoalState | null | undefined): number {
  return goal?.storageGeneration ?? 0
}

function validateState(value: unknown): GoalState | null {
  if (!value || typeof value !== "object") return null
  const state = value as Partial<GoalState>
  if (state.schemaVersion !== 1 || typeof state.id !== "string" || typeof state.sessionID !== "string" || typeof state.objective !== "string") return null
  if (!Array.isArray(state.requirements) || !Array.isArray(state.evidence) || !validGeneration(state.storageGeneration)) return null
  if (state.pendingContinuation !== undefined && typeof state.pendingContinuation !== "boolean") return null
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

function schemaVersionOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined
  return (value as { schemaVersion?: unknown }).schemaVersion
}

function parseStoredJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new GoalStoreIntegrityError(file, "invalid_json", "file is not valid JSON")
  }
}

function stateIntegrityDetail(value: unknown): string {
  const schema = schemaVersionOf(value)
  if (schema !== 1) return `unsupported schemaVersion ${String(schema)}`
  const generation = value && typeof value === "object" ? (value as { storageGeneration?: unknown }).storageGeneration : undefined
  if (!validGeneration(generation)) return `invalid storageGeneration ${String(generation)}`
  const pendingContinuation = value && typeof value === "object" ? (value as { pendingContinuation?: unknown }).pendingContinuation : undefined
  if (pendingContinuation !== undefined && typeof pendingContinuation !== "boolean") return `invalid pendingContinuation ${String(pendingContinuation)}`
  return "stored Goal state shape is invalid"
}

function archiveIntegrityDetail(value: unknown): string {
  const schema = schemaVersionOf(value)
  if (schema !== 1) return `unsupported archive schemaVersion ${String(schema)}`
  return "stored archive shape or session binding is invalid"
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function lstatIfPresent(file: string) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export async function assertGoalStoragePathSafe(directory: string, target: string): Promise<void> {
  const base = path.resolve(directory)
  const resolvedTarget = path.resolve(target)
  if (!isWithin(base, resolvedTarget)) {
    throw new GoalStoreIntegrityError(target, "unsafe_path", "storage path escapes the project directory")
  }

  const baseReal = await fs.realpath(base)
  const relative = path.relative(base, resolvedTarget)
  const parts = relative.split(path.sep).filter(Boolean)
  let current = base

  for (const part of parts) {
    current = path.join(current, part)
    const stat = await lstatIfPresent(current)
    if (!stat) break
    if (stat.isSymbolicLink()) {
      throw new GoalStoreIntegrityError(current, "unsafe_path", "storage path contains a symbolic link or junction")
    }

    const real = await fs.realpath(current)
    if (!isWithin(baseReal, real)) {
      throw new GoalStoreIntegrityError(current, "unsafe_path", "storage path resolves outside the project directory")
    }
  }
}

async function readStateFile(directory: string, file: string, expectedSessionID?: string): Promise<GoalState | null> {
  await assertGoalStoragePathSafe(directory, file)
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    throw error
  }

  const value = parseStoredJson(raw, file)
  const state = validateState(value)
  if (!state) throw new GoalStoreIntegrityError(file, "invalid_state", stateIntegrityDetail(value))
  if (expectedSessionID !== undefined && state.sessionID !== expectedSessionID) {
    throw new GoalStoreIntegrityError(file, "invalid_state", `stored Goal sessionID ${state.sessionID} does not match requested session ${expectedSessionID}`)
  }
  return state
}

async function writeAtomic(directory: string, target: string, value: unknown): Promise<void> {
  await assertGoalStoragePathSafe(directory, target)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await assertGoalStoragePathSafe(directory, target)

  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await assertGoalStoragePathSafe(directory, temp)
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })

  for (let attempt = 0; ; attempt += 1) {
    try {
      await assertGoalStoragePathSafe(directory, target)
      await fs.rename(temp, target)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (error instanceof GoalStoreIntegrityError || process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(String(code)) || attempt >= 5) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
      await assertGoalStoragePathSafe(directory, target)
      await fs.rm(target, { force: true }).catch(() => undefined)
    }
  }
}

async function removeStorageFile(directory: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await assertGoalStoragePathSafe(directory, target)
      await fs.rm(target, { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (error instanceof GoalStoreIntegrityError || process.platform !== "win32" || !["EPERM", "EACCES"].includes(String(code)) || attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

export class GoalStore {
  readonly directory: string
  readonly root: string
  readonly locksRoot: string
  readonly processLockTimeoutMs: number
  #locks = new Map<string, Promise<unknown>>()

  constructor(directory: string, options: GoalStoreOptions = {}) {
    this.directory = path.resolve(directory)
    this.root = path.join(this.directory, ".opencode", "goals")
    this.locksRoot = path.join(this.directory, ".opencode", "goal-locks")
    this.processLockTimeoutMs = options.processLockTimeoutMs ?? 5_000
    if (!Number.isFinite(this.processLockTimeoutMs) || this.processLockTimeoutMs < 1) throw new Error("processLockTimeoutMs must be positive")
  }

  fileFor(sessionID: string): string {
    return path.join(this.root, `${shard(sessionID)}.json`)
  }

  lockFileFor(sessionID: string): string {
    return path.join(this.locksRoot, `${shard(sessionID)}.lock`)
  }

  historyRootFor(sessionID: string): string {
    return path.join(this.root, "history", shard(sessionID))
  }

  archiveFileFor(sessionID: string, goalID: string): string {
    return path.join(this.historyRootFor(sessionID), `${shard(goalID)}.json`)
  }

  async load(sessionID: string): Promise<GoalState | null> {
    return await readStateFile(this.directory, this.fileFor(sessionID), sessionID)
  }

  async list(): Promise<GoalState[]> {
    await assertGoalStoragePathSafe(this.directory, this.root)
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
      const file = path.join(this.root, name)
      const state = await readStateFile(this.directory, file)
      if (state) {
        if (path.resolve(this.fileFor(state.sessionID)) !== path.resolve(file)) {
          throw new GoalStoreIntegrityError(file, "invalid_state", `stored Goal sessionID ${state.sessionID} does not match its shard path`)
        }
        states.push(state)
      }
    }
    return states
  }

  async history(sessionID: string, limit = 20): Promise<GoalArchiveRecord[]> {
    const records = await this.#history(sessionID)
    return records.slice(0, Math.max(0, limit))
  }

  async pruneHistory(sessionID: string, keep: number): Promise<GoalHistoryPruneResult> {
    if (!Number.isInteger(keep) || keep < 1) throw new Error("history prune keep must be a positive integer")
    return await this.#locked(sessionID, async () => {
      const records = await this.#history(sessionID)
      const kept = records.slice(0, keep)
      const removed = records.slice(keep)
      for (const record of removed) {
        await removeStorageFile(this.directory, this.archiveFileFor(sessionID, record.goalID))
      }
      return { keep, kept, removed }
    })
  }

  async restore(sessionID: string, goalIDPrefix: string, now = Date.now()): Promise<GoalRestoreResult> {
    return await this.#locked(sessionID, async () => {
      const normalized = goalIDPrefix.trim().toLowerCase()
      const records = await this.#history(sessionID)
      const matches = records.filter((record) => record.goalID.toLowerCase().startsWith(normalized))
      if (!matches.length) return { ok: false, reason: "not_found", matches: [] }
      if (matches.length > 1) return { ok: false, reason: "ambiguous", matches }

      const source = matches[0]!
      const current = await readStateFile(this.directory, this.fileFor(sessionID), sessionID)
      if (current && current.status !== "completed") return { ok: false, reason: "live_unfinished", current }
      if (current?.id === source.goalID) return { ok: false, reason: "already_current", current }
      if (source.goal.status === "completed") return { ok: false, reason: "completed", source }

      if (current) await this.#archive(current, "replaced")
      const nextGeneration = Math.max(storageGeneration(source.goal), storageGeneration(current)) + 1
      const restored: GoalState = {
        ...source.goal,
        status: "paused",
        stopReason: "Restored from goal history. Use /goal resume to continue.",
        storageGeneration: nextGeneration,
        updatedAt: now,
      }
      await writeAtomic(this.directory, this.fileFor(sessionID), restored)
      return { ok: true, goal: restored, source }
    })
  }

  async save(state: GoalState): Promise<void> {
    await this.#locked(state.sessionID, async () => {
      const file = this.fileFor(state.sessionID)
      const previous = await readStateFile(this.directory, file, state.sessionID)
      const expectedGeneration = storageGeneration(state)
      let nextGeneration: number

      if (!previous) {
        if (expectedGeneration !== 0) {
          throw new GoalStoreConcurrencyError(
            "stale_write",
            `expected generation ${expectedGeneration}, but the live snapshot no longer exists`,
            file,
          )
        }
        nextGeneration = 1
      } else if (previous.id === state.id) {
        const currentGeneration = storageGeneration(previous)
        if (expectedGeneration !== currentGeneration) {
          throw new GoalStoreConcurrencyError(
            "stale_write",
            `expected generation ${expectedGeneration}, but current generation is ${currentGeneration}`,
            file,
          )
        }
        nextGeneration = currentGeneration + 1
      } else {
        if (previous.status !== "completed") {
          throw new GoalStoreConcurrencyError(
            "live_replacement",
            `refused to replace unfinished Goal ${previous.id} with stale/concurrent Goal ${state.id}`,
            file,
          )
        }
        if (expectedGeneration !== 0) {
          throw new GoalStoreConcurrencyError(
            "stale_write",
            `new Goal ${state.id} carried unexpected generation ${expectedGeneration} while replacing ${previous.id}`,
            file,
          )
        }
        await this.#archive(previous, "replaced")
        nextGeneration = storageGeneration(previous) + 1
      }

      const persisted: GoalState = { ...state, storageGeneration: nextGeneration }
      await writeAtomic(this.directory, file, persisted)
      state.storageGeneration = nextGeneration
    })
  }

  async clear(sessionID: string): Promise<void> {
    await this.#locked(sessionID, async () => {
      const current = await readStateFile(this.directory, this.fileFor(sessionID), sessionID)
      if (current) await this.#archive(current, "cleared")
      await removeStorageFile(this.directory, this.fileFor(sessionID))
    })
  }

  async #history(sessionID: string): Promise<GoalArchiveRecord[]> {
    const historyRoot = this.historyRootFor(sessionID)
    await assertGoalStoragePathSafe(this.directory, historyRoot)
    let names: string[]
    try {
      names = await fs.readdir(historyRoot)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return []
      throw error
    }

    const records: GoalArchiveRecord[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const file = path.join(historyRoot, name)
      await assertGoalStoragePathSafe(this.directory, file)
      let raw: string
      try {
        raw = await fs.readFile(file, "utf8")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") continue
        throw error
      }
      const value = parseStoredJson(raw, file)
      const record = validateArchive(value, sessionID)
      if (!record) throw new GoalStoreIntegrityError(file, "invalid_archive", archiveIntegrityDetail(value))
      records.push(record)
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
    await writeAtomic(this.directory, this.archiveFileFor(goal.sessionID, goal.id), record)
  }

  async #locked<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const lease = await acquireGoalStoreProcessLock({
        lockRoot: this.locksRoot,
        lockFile: this.lockFileFor(sessionID),
        timeoutMs: this.processLockTimeoutMs,
        assertSafe: async (target) => await assertGoalStoragePathSafe(this.directory, target),
      })
      try {
        return await fn()
      } finally {
        await lease.release()
      }
    })
    this.#locks.set(sessionID, next)
    try {
      return await next
    } finally {
      if (this.#locks.get(sessionID) === next) this.#locks.delete(sessionID)
    }
  }
}
