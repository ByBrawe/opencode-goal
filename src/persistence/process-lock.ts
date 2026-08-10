import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

export type GoalStoreConcurrencyKind =
  | "lock_timeout"
  | "lock_corrupt"
  | "lock_lost"
  | "stale_write"
  | "live_replacement"

export class GoalStoreConcurrencyError extends Error {
  readonly code = "GOAL_STORE_CONCURRENCY"

  constructor(
    readonly kind: GoalStoreConcurrencyKind,
    message: string,
    readonly file?: string,
  ) {
    super(`Goal storage concurrency error (${kind}): ${message}`)
    this.name = "GoalStoreConcurrencyError"
  }
}

interface LockOwner {
  schemaVersion: 1
  pid: number
  token: string
  acquiredAt: number
  candidateName: string
}

export interface GoalStoreProcessLease {
  token: string
  release(): Promise<void>
}

export interface GoalStoreProcessLockInput {
  lockRoot: string
  lockFile: string
  timeoutMs: number
  assertSafe(target: string): Promise<void>
}

const POLL_MS = 20
const SAFE_PATH_RACE_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ownerFor(prefix: string): LockOwner {
  const token = randomUUID()
  return {
    schemaVersion: 1,
    pid: process.pid,
    token,
    acquiredAt: Date.now(),
    candidateName: `.${prefix}-${process.pid}-${token}.json`,
  }
}

function validOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object") return false
  const owner = value as Partial<LockOwner>
  return owner.schemaVersion === 1
    && Number.isInteger(owner.pid)
    && Number(owner.pid) > 0
    && typeof owner.token === "string"
    && owner.token.length > 0
    && typeof owner.acquiredAt === "number"
    && Number.isFinite(owner.acquiredAt)
    && typeof owner.candidateName === "string"
    && /^\.[a-z-]+-\d+-[0-9a-f-]+\.json$/i.test(owner.candidateName)
    && path.basename(owner.candidateName) === owner.candidateName
}

async function readOwner(file: string): Promise<LockOwner | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new GoalStoreConcurrencyError("lock_corrupt", `lock owner metadata is not valid JSON at ${file}`, file)
  }
  if (!validOwner(value)) {
    throw new GoalStoreConcurrencyError("lock_corrupt", `lock owner metadata is invalid at ${file}`, file)
  }
  return value
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== "ESRCH"
  }
}

async function removeWithRetry(file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(file, { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(String(code)) || attempt >= 5) throw error
      await sleep(10 * (attempt + 1))
    }
  }
}

/**
 * The storage guard intentionally inspects existing path components. Another
 * lock contender may remove a canonical lock between the guard's lstat and
 * realpath calls. Retry only that transient ENOENT; integrity/unsafe-path
 * errors are never swallowed, and a persistently missing project root still
 * fails after the bounded retries.
 */
async function assertSafeWithRaceRetry(target: string, assertSafe: (target: string) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await assertSafe(target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" || attempt >= SAFE_PATH_RACE_RETRIES) throw error
      await Promise.resolve()
    }
  }
}

/**
 * Canonical lock files are hard links to private candidate files by design.
 * On Windows, realpath() for a hard link may report a different equivalent
 * path alias (for example an 8.3 short-name ancestor), which must not be
 * mistaken for a storage escape. The parent directory remains the security
 * boundary. Existing symbolic links/junctions are still sent through the full
 * storage guard and therefore fail closed.
 */
async function assertSafeLockFile(target: string, assertSafe: (target: string) => Promise<void>): Promise<void> {
  await assertSafeWithRaceRetry(path.dirname(target), assertSafe)
  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (stat.isSymbolicLink()) await assertSafeWithRaceRetry(target, assertSafe)
}

async function createCandidate(
  lockRoot: string,
  owner: LockOwner,
  assertSafe: (target: string) => Promise<void>,
): Promise<string> {
  const candidate = path.join(lockRoot, owner.candidateName)
  await assertSafeWithRaceRetry(candidate, assertSafe)
  await fs.writeFile(candidate, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  return candidate
}

async function linkClaim(candidate: string, canonical: string, assertSafe: (target: string) => Promise<void>): Promise<boolean> {
  await assertSafeWithRaceRetry(candidate, assertSafe)
  await assertSafeLockFile(canonical, assertSafe)
  try {
    await fs.link(candidate, canonical)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

async function sameOwner(file: string, expected: LockOwner): Promise<boolean> {
  const owner = await readOwner(file)
  return owner?.token === expected.token && owner.pid === expected.pid
}

async function recoverDeadOwner(
  input: GoalStoreProcessLockInput,
  stale: LockOwner,
): Promise<boolean> {
  const cleanupFile = `${input.lockFile}.cleanup`
  const cleanup = ownerFor("cleanup-owner")
  const cleanupCandidate = await createCandidate(input.lockRoot, cleanup, input.assertSafe)
  let claimed = false
  try {
    claimed = await linkClaim(cleanupCandidate, cleanupFile, input.assertSafe)
    if (!claimed) return false

    // Only the process that owns the cleanup hard-link may remove a dead lock.
    // Re-read after claiming so a previously observed owner can never be used as
    // authority after the cleanup election boundary.
    const current = await readOwner(input.lockFile)
    if (!current) return true
    if (current.token !== stale.token || current.pid !== stale.pid) return false
    if (pidAlive(current.pid)) return false

    await assertSafeLockFile(input.lockFile, input.assertSafe)
    await removeWithRetry(input.lockFile)
    const staleCandidate = path.join(input.lockRoot, current.candidateName)
    await assertSafeWithRaceRetry(staleCandidate, input.assertSafe)
    await removeWithRetry(staleCandidate).catch(() => undefined)
    return true
  } finally {
    if (claimed) {
      const owner = await readOwner(cleanupFile).catch(() => null)
      if (owner?.token === cleanup.token) await removeWithRetry(cleanupFile).catch(() => undefined)
    }
    await removeWithRetry(cleanupCandidate).catch(() => undefined)
  }
}

export async function acquireGoalStoreProcessLock(input: GoalStoreProcessLockInput): Promise<GoalStoreProcessLease> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1) throw new Error("process lock timeout must be positive")

  await assertSafeWithRaceRetry(input.lockRoot, input.assertSafe)
  await fs.mkdir(input.lockRoot, { recursive: true })
  await assertSafeWithRaceRetry(input.lockRoot, input.assertSafe)
  await assertSafeWithRaceRetry(input.lockFile, input.assertSafe)

  const owner = ownerFor("lock-owner")
  const candidate = await createCandidate(input.lockRoot, owner, input.assertSafe)
  const startedAt = Date.now()
  let acquired = false

  try {
    while (!acquired) {
      if (await linkClaim(candidate, input.lockFile, input.assertSafe)) {
        acquired = true
        break
      }

      const current = await readOwner(input.lockFile)
      if (!current) continue
      if (!pidAlive(current.pid)) await recoverDeadOwner(input, current)

      if (Date.now() - startedAt >= input.timeoutMs) {
        throw new GoalStoreConcurrencyError(
          "lock_timeout",
          `timed out after ${input.timeoutMs}ms waiting for the session storage lease held by pid ${current.pid}`,
          input.lockFile,
        )
      }
      await sleep(POLL_MS)
    }

    return {
      token: owner.token,
      release: async () => {
        const current = await readOwner(input.lockFile)
        if (!current || current.token !== owner.token || current.pid !== owner.pid) {
          throw new GoalStoreConcurrencyError("lock_lost", "session storage lease ownership changed before release", input.lockFile)
        }
        await assertSafeLockFile(input.lockFile, input.assertSafe)
        await removeWithRetry(input.lockFile)
        await removeWithRetry(candidate).catch(() => undefined)
      },
    }
  } catch (error) {
    if (acquired && await sameOwner(input.lockFile, owner).catch(() => false)) {
      await removeWithRetry(input.lockFile).catch(() => undefined)
    }
    await removeWithRetry(candidate).catch(() => undefined)
    throw error
  }
}
