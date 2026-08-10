import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore, GoalStoreIntegrityError } from "../dist/persistence/store.js"

test("persisted pendingContinuation must be boolean in live Goal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-pending-integrity-live-"))
  try {
    const sessionID = "session-pending-live"
    const store = new GoalStore(root)
    const goal = { ...createGoal({ sessionID, objective: "continue safely" }), pendingContinuation: true }
    await store.save(goal)

    const file = store.fileFor(sessionID)
    const value = JSON.parse(await readFile(file, "utf8"))
    value.pendingContinuation = "yes"
    const corrupt = `${JSON.stringify(value, null, 2)}\n`
    await writeFile(file, corrupt, "utf8")

    const isPendingIntegrityError = (error) => error instanceof GoalStoreIntegrityError
      && error.kind === "invalid_state"
      && /invalid pendingContinuation yes/.test(error.message)

    await assert.rejects(() => store.load(sessionID), isPendingIntegrityError)
    await assert.rejects(() => store.list(), isPendingIntegrityError)
    await assert.rejects(() => store.save(createGoal({ sessionID, objective: "replacement" })), isPendingIntegrityError)
    await assert.rejects(() => store.clear(sessionID), isPendingIntegrityError)
    assert.equal(await readFile(file, "utf8"), corrupt, "invalid continuation state must remain byte-for-byte untouched")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("persisted pendingContinuation must be boolean inside Goal archives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-pending-integrity-archive-"))
  try {
    const sessionID = "session-pending-archive"
    const store = new GoalStore(root)
    const goal = { ...createGoal({ sessionID, objective: "archive safely", now: 100 }), pendingContinuation: true }
    await store.save(goal)
    await store.clear(sessionID)

    const archiveFile = store.archiveFileFor(sessionID, goal.id)
    await mkdir(path.dirname(archiveFile), { recursive: true })
    const value = JSON.parse(await readFile(archiveFile, "utf8"))
    value.goal.pendingContinuation = 1
    const corrupt = `${JSON.stringify(value, null, 2)}\n`
    await writeFile(archiveFile, corrupt, "utf8")

    const isArchiveIntegrityError = (error) => error instanceof GoalStoreIntegrityError
      && error.kind === "invalid_archive"

    await assert.rejects(() => store.history(sessionID), isArchiveIntegrityError)
    await assert.rejects(() => store.restore(sessionID, goal.id.slice(0, 12), 200), isArchiveIntegrityError)
    await assert.rejects(() => store.pruneHistory(sessionID, 1), isArchiveIntegrityError)
    assert.equal(await store.load(sessionID), null)
    assert.equal(await readFile(archiveFile, "utf8"), corrupt, "invalid archived continuation state must remain byte-for-byte untouched")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
