import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireGoalStoreProcessLock, GoalStoreConcurrencyError } from "../dist/persistence/process-lock.js"

function unsupported(code) {
  const error = new Error(`synthetic hard-link unsupported: ${code}`)
  error.code = code
  return error
}

test("exFAT-style hard-link failure uses exclusive file claims for acquisition and cleanup election", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goal-exfat-lock-"))
  const lockRoot = path.join(root, "locks")
  const lockFile = path.join(lockRoot, "session.lock")
  const input = { lockRoot, lockFile, timeoutMs: 160, assertSafe: async () => {} }
  const originalLink = fs.link
  let injected = 0
  let holder
  try {
    fs.link = async () => { injected++; throw unsupported("EISDIR") }
    holder = await acquireGoalStoreProcessLock(input)
    assert.ok(injected > 0)
    assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, holder.token)
    await assert.rejects(
      () => acquireGoalStoreProcessLock(input),
      (error) => error instanceof GoalStoreConcurrencyError && error.kind === "lock_timeout",
    )
    await holder.release()
    holder = undefined

    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" })
    assert.equal(dead.status, 0)
    const token = randomUUID()
    const candidateName = `.lock-owner-${dead.pid}-${token}.json`
    const candidate = path.join(lockRoot, candidateName)
    const owner = { schemaVersion: 1, pid: dead.pid, token, acquiredAt: Date.now(), candidateName }
    await writeFile(candidate, JSON.stringify(owner))
    await writeFile(lockFile, JSON.stringify(owner))
    holder = await acquireGoalStoreProcessLock(input)
    assert.notEqual(holder.token, token, "dead owner's session lock was recovered")
    assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, holder.token)
    await assert.rejects(fs.access(candidate), { code: "ENOENT" })
    await holder.release()
    holder = undefined

    await writeFile(lockFile, "corrupt metadata")
    await assert.rejects(
      () => acquireGoalStoreProcessLock(input),
      (error) => error instanceof GoalStoreConcurrencyError && error.kind === "lock_corrupt",
      "malformed owner must never be stolen",
    )
    assert.equal(await readFile(lockFile, "utf8"), "corrupt metadata")
    await rm(lockFile)
  } finally {
    fs.link = originalLink
    await holder?.release().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test("unsupported hard-link codes fall back but unexpected I/O failures do not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goal-link-errors-"))
  const originalLink = fs.link
  try {
    for (const code of ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]) {
      fs.link = async () => { throw unsupported(code) }
      const lockRoot = path.join(root, code)
      const lockFile = path.join(lockRoot, "session.lock")
      const lease = await acquireGoalStoreProcessLock({ lockRoot, lockFile, timeoutMs: 150, assertSafe: async () => {} })
      await lease.release()
      await assert.rejects(fs.access(lockFile), { code: "ENOENT" })
    }
    fs.link = async () => { throw unsupported("ENOSPC") }
    await assert.rejects(
      () => acquireGoalStoreProcessLock({
        lockRoot: path.join(root, "unexpected"),
        lockFile: path.join(root, "unexpected", "session.lock"),
        timeoutMs: 150, assertSafe: async () => {},
      }),
      { code: "ENOSPC" },
    )
  } finally {
    fs.link = originalLink
    await rm(root, { recursive: true, force: true })
  }
})
