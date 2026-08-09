import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal } from "../dist/domain/goal.js"
import { diagnoseGoalStorage } from "../dist/persistence/diagnostics.js"
import { GoalStore, GoalStoreIntegrityError } from "../dist/persistence/store.js"
import { captureStartupGoals } from "../dist/opencode/recovery.js"

const directoryLinkType = process.platform === "win32" ? "junction" : "dir"

function isUnsafePath(error) {
  return error instanceof GoalStoreIntegrityError
    && error.kind === "unsafe_path"
    && /symbolic link|junction|outside the project/.test(error.message)
}

test("live Goal storage refuses symlink or junction escape before any external write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-storage-link-"))
  const external = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-storage-external-"))
  try {
    await mkdir(path.join(root, ".opencode"), { recursive: true })
    await symlink(external, path.join(root, ".opencode", "goals"), directoryLinkType)

    const sessionID = "unsafe-live-session"
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "must stay local" })

    await assert.rejects(() => store.save(goal), isUnsafePath)
    await assert.rejects(() => store.load(sessionID), isUnsafePath)
    assert.deepEqual(await readdir(external), [], "unsafe live storage must not create files outside the project")

    const doctor = await diagnoseGoalStorage(root, sessionID)
    assert.ok(doctor.issues.some((issue) => issue.kind === "unsafe_path"))
    assert.match(doctor.issues[0].file, /\.opencode\/goals/)
    assert.deepEqual(await captureStartupGoals(root), [], "startup recovery must not traverse the unsafe storage root")
    assert.deepEqual(await readdir(external), [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test("archive history refuses symlink or junction escape before read or prune", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-history-link-"))
  const external = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-history-external-"))
  try {
    const sessionID = "unsafe-history-session"
    const store = new GoalStore(root)
    const historyRoot = store.historyRootFor(sessionID)
    await mkdir(path.dirname(historyRoot), { recursive: true })
    await writeFile(path.join(external, "sentinel.txt"), "do-not-touch\n", "utf8")
    await symlink(external, historyRoot, directoryLinkType)

    await assert.rejects(() => store.history(sessionID), isUnsafePath)
    await assert.rejects(() => store.pruneHistory(sessionID, 1), isUnsafePath)

    const doctor = await diagnoseGoalStorage(root, sessionID)
    assert.equal(doctor.live.state, "missing")
    assert.equal(doctor.archives.state, "invalid")
    assert.equal(doctor.archives.issue.kind, "unsafe_path")
    assert.equal(await readFile(path.join(external, "sentinel.txt"), "utf8"), "do-not-touch\n")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})
