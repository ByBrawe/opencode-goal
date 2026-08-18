import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  acquireGoalStoreProcessLock,
  GoalStoreConcurrencyError,
} from "../dist/persistence/process-lock.js"

function accessError(code) {
  const error = new Error(`synthetic ${code} process-lock access denial`)
  error.code = code
  return error
}

test("transient Windows process-lock owner read denial is retried but a persistent denial still fails closed", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-lock-read-retry-"))
  const lockRoot = path.join(root, "locks")
  const lockFile = path.join(lockRoot, "session.lock")
  const originalReadFile = fs.readFile
  let holder

  try {
    const input = {
      lockRoot,
      lockFile,
      timeoutMs: 250,
      assertSafe: async () => {},
    }
    holder = await acquireGoalStoreProcessLock(input)

    let transientInjected = false
    fs.readFile = async (...args) => {
      const target = path.resolve(String(args[0]))
      if (!transientInjected && target === path.resolve(lockFile)) {
        transientInjected = true
        throw accessError("EPERM")
      }
      return await originalReadFile(...args)
    }

    await assert.rejects(
      () => acquireGoalStoreProcessLock(input),
      (error) => error instanceof GoalStoreConcurrencyError && error.kind === "lock_timeout",
      "one transient EPERM must be retried so the normal live-owner timeout remains authoritative",
    )
    assert.equal(transientInjected, true)

    fs.readFile = async (...args) => {
      const target = path.resolve(String(args[0]))
      if (target === path.resolve(lockFile)) throw accessError("EPERM")
      return await originalReadFile(...args)
    }

    await assert.rejects(
      () => acquireGoalStoreProcessLock({ ...input, timeoutMs: 500 }),
      (error) => error?.code === "EPERM" && !(error instanceof GoalStoreConcurrencyError),
      "a persistent access denial must escape after the bounded retry window instead of being converted into a concurrency result",
    )
  } finally {
    fs.readFile = originalReadFile
    await holder?.release().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test("transient Windows canonical lock lstat denial is retried but a persistent denial still fails closed", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-lock-lstat-retry-"))
  const lockRoot = path.join(root, "locks")
  const lockFile = path.join(lockRoot, "session.lock")
  const originalLstat = fs.lstat
  let holder

  try {
    const input = {
      lockRoot,
      lockFile,
      timeoutMs: 250,
      assertSafe: async () => {},
    }
    holder = await acquireGoalStoreProcessLock(input)

    let transientInjected = false
    fs.lstat = async (...args) => {
      const target = path.resolve(String(args[0]))
      if (!transientInjected && target === path.resolve(lockFile)) {
        transientInjected = true
        throw accessError("EPERM")
      }
      return await originalLstat(...args)
    }

    await assert.rejects(
      () => acquireGoalStoreProcessLock(input),
      (error) => error instanceof GoalStoreConcurrencyError && error.kind === "lock_timeout",
      "one transient lstat EPERM must be retried so the normal live-owner timeout remains authoritative",
    )
    assert.equal(transientInjected, true)

    fs.lstat = async (...args) => {
      const target = path.resolve(String(args[0]))
      if (target === path.resolve(lockFile)) throw accessError("EPERM")
      return await originalLstat(...args)
    }

    await assert.rejects(
      () => acquireGoalStoreProcessLock({ ...input, timeoutMs: 500 }),
      (error) => error?.code === "EPERM" && !(error instanceof GoalStoreConcurrencyError),
      "persistent lstat access denial must escape after the bounded retry window",
    )
  } finally {
    fs.lstat = originalLstat
    await holder?.release().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
