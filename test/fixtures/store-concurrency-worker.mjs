import { access, writeFile } from "node:fs/promises"
import process from "node:process"
import { GoalStore, GoalStoreConcurrencyError, assertGoalStoragePathSafe } from "../../dist/persistence/store.js"
import { acquireGoalStoreProcessLock } from "../../dist/persistence/process-lock.js"

const [mode, root, sessionID, firstPath, secondPath, marker] = process.argv.slice(2)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(file, timeoutMs = 10_000) {
  const started = Date.now()
  while (true) {
    try {
      await access(file)
      return
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for ${file}`)
    await sleep(10)
  }
}

async function leaseFor(store, timeoutMs = 5_000) {
  return await acquireGoalStoreProcessLock({
    lockRoot: store.locksRoot,
    lockFile: store.lockFileFor(sessionID),
    timeoutMs,
    assertSafe: async (target) => await assertGoalStoragePathSafe(store.directory, target),
  })
}

async function main() {
  if (mode === "stale-writer") {
    const store = new GoalStore(root, { processLockTimeoutMs: 5_000 })
    const snapshot = await store.load(sessionID)
    if (!snapshot) throw new Error("worker could not load the shared Goal")
    await writeFile(firstPath, `${process.pid}\n`, "utf8")
    await waitFor(secondPath)
    snapshot.stopReason = marker
    snapshot.updatedAt = Date.now()
    try {
      await store.save(snapshot)
      console.log(JSON.stringify({ result: "success", marker, generation: snapshot.storageGeneration }))
    } catch (error) {
      if (error instanceof GoalStoreConcurrencyError) {
        console.log(JSON.stringify({ result: "conflict", marker, kind: error.kind }))
        return
      }
      throw error
    }
    return
  }

  if (mode === "hold-lock") {
    const store = new GoalStore(root, { processLockTimeoutMs: 5_000 })
    const lease = await leaseFor(store)
    try {
      await writeFile(firstPath, `${process.pid}\n`, "utf8")
      await waitFor(secondPath)
    } finally {
      await lease.release()
    }
    console.log(JSON.stringify({ result: "released" }))
    return
  }

  if (mode === "crash-lock") {
    const store = new GoalStore(root, { processLockTimeoutMs: 5_000 })
    await leaseFor(store)
    await writeFile(firstPath, `${process.pid}\n`, "utf8")
    console.log(JSON.stringify({ result: "crashing", pid: process.pid }))
    process.exit(0)
  }

  throw new Error(`unknown worker mode: ${mode}`)
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
