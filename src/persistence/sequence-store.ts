import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { createGoal } from "../domain/goal.js"
import type {
  GoalSequenceClearResult,
  GoalSequenceMoveResult,
  GoalSequencePromotionResult,
  GoalSequenceSelectResult,
  GoalSequenceState,
  QueueGoalInput,
  QueuedGoalSpec,
} from "../domain/sequence.js"
import type { GoalState } from "../domain/types.js"
import { acquireGoalStoreProcessLock } from "./process-lock.js"
import { assertGoalStoragePathSafe, GoalStore, GoalStoreIntegrityError, type GoalArchiveRecord } from "./store.js"

function shard(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function normalizeStrings(items: string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter(Boolean)
}

function normalizeFiles(items: QueueGoalInput["files"]): NonNullable<QueueGoalInput["files"]> {
  return (items ?? [])
    .map((item) => ({ file: item.file.trim(), ...(item.contains?.trim() ? { contains: item.contains.trim() } : {}) }))
    .filter((item) => item.file)
}

function validBudget(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  for (const [key, item] of Object.entries(value)) {
    if (!["maxTurns", "maxTokens", "maxCost", "maxRuntimeMs"].includes(key)) return false
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) return false
    if ((key === "maxTurns" || key === "maxTokens") && !Number.isInteger(item)) return false
  }
  return true
}

function validQueuedGoal(value: unknown): value is QueuedGoalSpec {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<QueuedGoalSpec>
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.objective === "string" && item.objective.trim().length > 0
    && Array.isArray(item.acceptance) && item.acceptance.every((entry) => typeof entry === "string")
    && Array.isArray(item.constraints) && item.constraints.every((entry) => typeof entry === "string")
    && Array.isArray(item.checks) && item.checks.every((entry) => typeof entry === "string")
    && Array.isArray(item.files) && item.files.every((entry) => entry && typeof entry === "object" && typeof entry.file === "string" && (entry.contains === undefined || typeof entry.contains === "string"))
    && validBudget(item.budget)
    && typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
    && (item.activating === undefined || typeof item.activating === "boolean")
}

function validateSequence(value: unknown, sessionID: string): GoalSequenceState | null {
  if (!value || typeof value !== "object") return null
  const state = value as Partial<GoalSequenceState>
  if (state.schemaVersion !== 1 || state.sessionID !== sessionID) return null
  if (!Number.isSafeInteger(state.generation) || Number(state.generation) < 0) return null
  if (typeof state.updatedAt !== "number" || !Number.isFinite(state.updatedAt)) return null
  if (!Array.isArray(state.items) || !state.items.every(validQueuedGoal)) return null
  const ids = new Set(state.items.map((item) => item.id))
  if (ids.size !== state.items.length) return null
  const activating = state.items.filter((item) => item.activating)
  if (activating.length > 1 || (activating.length === 1 && state.items[0]?.id !== activating[0]?.id)) return null
  return value as GoalSequenceState
}

export type GoalSequenceIntegrityKind = "invalid_json" | "invalid_state"

export class GoalSequenceIntegrityError extends Error {
  readonly code = "GOAL_SEQUENCE_INTEGRITY"

  constructor(readonly file: string, readonly kind: GoalSequenceIntegrityKind, detail: string) {
    super(`Goal sequence integrity error (${kind}) at ${file}: ${detail}`)
    this.name = "GoalSequenceIntegrityError"
  }
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    if (error instanceof SyntaxError) throw new GoalSequenceIntegrityError(file, "invalid_json", "file is not valid JSON")
    throw error
  }
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
      return
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

function emptySequence(sessionID: string, now = Date.now()): GoalSequenceState {
  return { schemaVersion: 1, sessionID, generation: 0, items: [], updatedAt: now }
}

function nextSequence(state: GoalSequenceState, items: QueuedGoalSpec[], now = Date.now()): GoalSequenceState {
  return { ...state, generation: state.generation + 1, items, updatedAt: now }
}

function matchesPrefix(items: QueuedGoalSpec[], prefix: string): QueuedGoalSpec[] {
  const normalized = prefix.trim().toLowerCase()
  return items.filter((item) => item.id.toLowerCase().startsWith(normalized))
}

function storageGeneration(goal: GoalState | null | undefined): number {
  return goal?.storageGeneration ?? 0
}

export class GoalSequenceStore {
  readonly directory: string
  readonly root: string
  readonly goals: GoalStore
  #locks = new Map<string, Promise<unknown>>()

  constructor(directory: string, processLockTimeoutMs = 5_000) {
    this.directory = path.resolve(directory)
    this.root = path.join(this.directory, ".opencode", "goal-sequences")
    this.goals = new GoalStore(this.directory, { processLockTimeoutMs })
  }

  fileFor(sessionID: string): string {
    return path.join(this.root, `${shard(sessionID)}.json`)
  }

  async load(sessionID: string): Promise<GoalSequenceState> {
    const file = this.fileFor(sessionID)
    await assertGoalStoragePathSafe(this.directory, file)
    const value = await readJson(file)
    if (value === null) return emptySequence(sessionID)
    const state = validateSequence(value, sessionID)
    if (!state) throw new GoalSequenceIntegrityError(file, "invalid_state", "stored sequence shape or session binding is invalid")
    return state
  }

  async enqueue(sessionID: string, input: QueueGoalInput): Promise<{ item: QueuedGoalSpec; sequence: GoalSequenceState }> {
    return await this.#locked(sessionID, async () => {
      const objective = input.objective.trim()
      if (!objective) throw new Error("queued goal objective must not be empty")
      const state = await this.load(sessionID)
      if (state.items.some((item) => item.activating)) throw new Error("Goal queue activation is incomplete; retry after recovery settles")
      const item: QueuedGoalSpec = {
        id: randomUUID(),
        objective,
        acceptance: normalizeStrings(input.acceptance),
        constraints: normalizeStrings(input.constraints),
        checks: normalizeStrings(input.checks),
        files: normalizeFiles(input.files),
        budget: { ...(input.budget ?? {}) },
        createdAt: input.now ?? Date.now(),
      }
      const sequence = nextSequence(state, [...state.items, item], input.now)
      await writeAtomic(this.directory, this.fileFor(sessionID), sequence)
      return { item, sequence }
    })
  }

  async remove(sessionID: string, prefix: string): Promise<GoalSequenceSelectResult> {
    return await this.#locked(sessionID, async () => {
      const state = await this.load(sessionID)
      if (state.items.some((item) => item.activating)) return { ok: false, reason: "activating", matches: state.items.filter((item) => item.activating) }
      const matches = matchesPrefix(state.items, prefix)
      if (!matches.length) return { ok: false, reason: "not_found", matches: [] }
      if (matches.length > 1) return { ok: false, reason: "ambiguous", matches }
      const item = matches[0]!
      if (item.activating) return { ok: false, reason: "activating", matches }
      const sequence = nextSequence(state, state.items.filter((entry) => entry.id !== item.id))
      await writeAtomic(this.directory, this.fileFor(sessionID), sequence)
      return { ok: true, item, sequence }
    })
  }

  async move(sessionID: string, prefix: string, position: number): Promise<GoalSequenceMoveResult> {
    return await this.#locked(sessionID, async () => {
      const state = await this.load(sessionID)
      const matches = matchesPrefix(state.items, prefix)
      if (!matches.length) return { ok: false, reason: "not_found", matches: [] }
      if (matches.length > 1) return { ok: false, reason: "ambiguous", matches }
      if (!Number.isInteger(position) || position < 1 || position > state.items.length) return { ok: false, reason: "position", matches }
      if (state.items.some((item) => item.activating)) return { ok: false, reason: "activating", matches: state.items.filter((item) => item.activating) }
      const item = matches[0]!
      const items = state.items.filter((entry) => entry.id !== item.id)
      items.splice(position - 1, 0, item)
      const sequence = nextSequence(state, items)
      await writeAtomic(this.directory, this.fileFor(sessionID), sequence)
      return { ok: true, item, position, sequence }
    })
  }

  async clear(sessionID: string): Promise<GoalSequenceClearResult> {
    return await this.#locked(sessionID, async () => {
      const state = await this.load(sessionID)
      const activating = state.items.filter((item) => item.activating)
      if (activating.length) return { ok: false, reason: "activating", matches: activating }
      const removed = [...state.items]
      const sequence = nextSequence(state, [])
      await writeAtomic(this.directory, this.fileFor(sessionID), sequence)
      return { ok: true, removed, sequence }
    })
  }

  async promoteNext(sessionID: string, now = Date.now()): Promise<GoalSequencePromotionResult> {
    return await this.#locked(sessionID, async () => {
      let sequence = await this.load(sessionID)
      const head = sequence.items[0]
      if (!head) return { ok: false, reason: "empty" }

      const current = await this.goals.load(sessionID)
      if (current?.id === head.id) {
        sequence = nextSequence(sequence, sequence.items.slice(1), now)
        await writeAtomic(this.directory, this.fileFor(sessionID), sequence)
        return { ok: true, goal: current, queued: head, recovered: true, remaining: sequence.items.length }
      }
      if (current && current.status !== "completed") return { ok: false, reason: "live_unfinished", current }

      let queued = head
      if (!head.activating) {
        queued = { ...head, activating: true }
        sequence = nextSequence(sequence, [queued, ...sequence.items.slice(1)], now)
        await writeAtomic(this.directory, this.fileFor(sessionID), sequence)
      }

      const created = createGoal({
        sessionID,
        objective: queued.objective,
        acceptance: queued.acceptance,
        constraints: queued.constraints,
        checks: queued.checks,
        files: queued.files,
        budget: queued.budget,
        ...(current?.execution ? { execution: current.execution } : {}),
        now,
      })
      const next: GoalState = {
        ...created,
        id: queued.id,
        storageGeneration: storageGeneration(current) + 1,
        pendingContinuation: true,
      }

      if (current) {
        const archive: GoalArchiveRecord = {
          schemaVersion: 1,
          goalID: current.id,
          sessionID,
          reason: "replaced",
          archivedAt: now,
          goal: current,
        }
        await writeAtomic(this.directory, this.goals.archiveFileFor(sessionID, current.id), archive)
      }
      await writeAtomic(this.directory, this.goals.fileFor(sessionID), next)

      const finalSequence = nextSequence(sequence, sequence.items.slice(1), now)
      await writeAtomic(this.directory, this.fileFor(sessionID), finalSequence)
      return { ok: true, goal: next, queued, recovered: false, remaining: finalSequence.items.length }
    })
  }

  async #locked<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const lease = await acquireGoalStoreProcessLock({
        lockRoot: this.goals.locksRoot,
        lockFile: this.goals.lockFileFor(sessionID),
        timeoutMs: this.goals.processLockTimeoutMs,
        assertSafe: async (target: string) => await assertGoalStoragePathSafe(this.directory, target),
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
