import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore, GoalStoreIntegrityError } from "../dist/persistence/store.js"
import { currentGoalRuntimeFingerprint, formatGoalRuntimeFingerprint } from "../dist/runtime/fingerprint.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJSON = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))

test("new Goals persist the loaded runtime package and build identity", () => {
  const goal = createGoal({ sessionID: "runtime-fingerprint-new", objective: "record runtime identity", now: 100 })
  const fingerprint = goal.runtimeFingerprint
  assert.ok(fingerprint)
  assert.equal(fingerprint.goalVersion, packageJSON.version)
  assert.equal(fingerprint.goalVersion, currentGoalRuntimeFingerprint().goalVersion)
  assert.match(fingerprint.goalBuild ?? "", /^(?:sha256:[0-9a-f]{64}|git:.+)$/)

  const formatted = formatGoalRuntimeFingerprint(fingerprint)
  assert.match(formatted, new RegExp(`Goal ${packageJSON.version.replaceAll(".", "\\.")}`))
  assert.match(formatted, /build /)
})

test("read-only legacy load stays unchanged until a real save stamps the current runtime once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-runtime-fingerprint-"))
  try {
    const sessionID = "runtime-fingerprint-legacy"
    const store = new GoalStore(directory)
    const goal = createGoal({ sessionID, objective: "upgrade runtime identity only on save", now: 100 })
    await store.save(goal)
    assert.equal(goal.storageGeneration, 1)

    const file = store.fileFor(sessionID)
    const legacy = JSON.parse(await readFile(file, "utf8"))
    delete legacy.runtimeFingerprint
    await writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`, "utf8")

    const loaded = await store.load(sessionID)
    assert.ok(loaded)
    assert.equal(loaded.runtimeFingerprint, undefined)
    assert.equal(JSON.parse(await readFile(file, "utf8")).runtimeFingerprint, undefined, "read-only load must not rewrite legacy state")

    loaded.updatedAt = 200
    await store.save(loaded)
    assert.equal(loaded.storageGeneration, 2, "first save under the new runtime should persist the fingerprint")
    assert.equal(loaded.runtimeFingerprint?.goalVersion, packageJSON.version)

    const current = await store.load(sessionID)
    assert.ok(current)
    const persistedUpdatedAt = current.updatedAt
    current.updatedAt = 300
    await store.save(current)
    assert.equal(current.storageGeneration, 2, "unchanged runtime identity must not create another semantic write")
    assert.equal(current.updatedAt, persistedUpdatedAt)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("corrupt persisted runtime fingerprints fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-runtime-fingerprint-invalid-"))
  try {
    const sessionID = "runtime-fingerprint-invalid"
    const store = new GoalStore(directory)
    const goal = createGoal({ sessionID, objective: "reject corrupt runtime identity", now: 100 })
    await store.save(goal)

    const file = store.fileFor(sessionID)
    const corrupt = JSON.parse(await readFile(file, "utf8"))
    corrupt.runtimeFingerprint = { goalVersion: "" }
    await writeFile(file, `${JSON.stringify(corrupt, null, 2)}\n`, "utf8")

    await assert.rejects(
      () => store.load(sessionID),
      (error) => error instanceof GoalStoreIntegrityError
        && error.kind === "invalid_state"
        && error.message.includes("invalid runtimeFingerprint"),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
