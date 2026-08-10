import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore, GoalStoreIntegrityError } from "../dist/persistence/store.js"

test("GoalStore rejects a live snapshot whose sessionID does not match its shard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-session-binding-"))
  try {
    const expectedSession = "expected-session"
    const foreignSession = "foreign-session"
    const store = new GoalStore(root)
    const foreign = createGoal({ sessionID: foreignSession, objective: "must not cross sessions" })
    await mkdir(path.dirname(store.fileFor(expectedSession)), { recursive: true })
    await writeFile(store.fileFor(expectedSession), `${JSON.stringify(foreign, null, 2)}\n`)

    await assert.rejects(
      () => store.load(expectedSession),
      (error) => error instanceof GoalStoreIntegrityError && error.kind === "invalid_state" && /session/i.test(error.message),
    )
    await assert.rejects(
      () => store.list(),
      (error) => error instanceof GoalStoreIntegrityError && error.kind === "invalid_state" && /shard|session/i.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
