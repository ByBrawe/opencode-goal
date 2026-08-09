import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore, GoalStoreConcurrencyError } from "../dist/persistence/store.js"

const worker = fileURLToPath(new URL("../scripts/store-concurrency-worker.mjs", import.meta.url))

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

function launch(args) {
  const child = spawn(process.execPath, [worker, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr, code, signal })
      else reject(new Error(`worker failed code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
  return { child, done }
}

function jsonLine(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean)
  return JSON.parse(lines.at(-1))
}

test("live cross-process lease blocks a second writer until timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-process-lock-"))
  try {
    const sessionID = "lease-timeout-session"
    const store = new GoalStore(root)
    const initial = createGoal({ sessionID, objective: "serialize writes" })
    await store.save(initial)
    assert.equal(initial.storageGeneration, 1)

    const snapshot = await store.load(sessionID)
    const ready = path.join(root, "holder-ready")
    const release = path.join(root, "holder-release")
    const holder = launch(["hold-lock", root, sessionID, ready, release, "unused"])
    await waitFor(ready)

    const contender = new GoalStore(root, { processLockTimeoutMs: 150 })
    const attempted = { ...snapshot, stopReason: "must not write while another process owns the lease", updatedAt: Date.now() }
    await assert.rejects(
      () => contender.save(attempted),
      (error) => error instanceof GoalStoreConcurrencyError && error.kind === "lock_timeout",
    )
    assert.equal((await store.load(sessionID)).stopReason, undefined)

    await writeFile(release, "release\n", "utf8")
    await holder.done
    snapshot.stopReason = "written after release"
    snapshot.updatedAt = Date.now()
    await store.save(snapshot)
    assert.equal(snapshot.storageGeneration, 2)
    assert.equal((await store.load(sessionID)).stopReason, "written after release")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("two stale process snapshots cannot both commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-process-race-"))
  try {
    const sessionID = "stale-race-session"
    const store = new GoalStore(root)
    const initial = createGoal({ sessionID, objective: "reject stale writers" })
    await store.save(initial)
    assert.equal(initial.storageGeneration, 1)

    const readyA = path.join(root, "ready-a")
    const readyB = path.join(root, "ready-b")
    const go = path.join(root, "go")
    const a = launch(["stale-writer", root, sessionID, readyA, go, "writer-a"])
    const b = launch(["stale-writer", root, sessionID, readyB, go, "writer-b"])
    await Promise.all([waitFor(readyA), waitFor(readyB)])
    await writeFile(go, "go\n", "utf8")

    const [resultA, resultB] = await Promise.all([a.done, b.done])
    const outcomes = [jsonLine(resultA.stdout), jsonLine(resultB.stdout)]
    assert.equal(outcomes.filter((item) => item.result === "success").length, 1)
    assert.equal(outcomes.filter((item) => item.result === "conflict" && item.kind === "stale_write").length, 1)

    const final = await store.load(sessionID)
    const winner = outcomes.find((item) => item.result === "success")
    assert.equal(final.storageGeneration, 2)
    assert.equal(final.stopReason, winner.marker)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("dead process lease is reclaimed without stealing a live owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-process-crash-"))
  try {
    const sessionID = "dead-owner-session"
    const store = new GoalStore(root, { processLockTimeoutMs: 2_000 })
    const initial = createGoal({ sessionID, objective: "survive lock owner crash" })
    await store.save(initial)
    const snapshot = await store.load(sessionID)

    const ready = path.join(root, "crash-ready")
    const crash = launch(["crash-lock", root, sessionID, ready, path.join(root, "unused"), "unused"])
    await waitFor(ready)
    await crash.done

    snapshot.stopReason = "continued after dead owner"
    snapshot.updatedAt = Date.now()
    await store.save(snapshot)
    assert.equal(snapshot.storageGeneration, 2)
    assert.equal((await store.load(sessionID)).stopReason, "continued after dead owner")

    await assert.rejects(() => access(store.lockFileFor(sessionID)))
    const lockEntries = await readdir(store.locksRoot)
    assert.equal(lockEntries.filter((name) => name.endsWith(".lock") || name.includes("lock-owner")).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
