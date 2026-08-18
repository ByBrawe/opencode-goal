import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { beginWorkspaceMutationWatch } from "../dist/runtime/workspace-mutation-watch.js"

async function watchMutation(root, mutate) {
  const watcher = await beginWorkspaceMutationWatch(root)
  assert.ok(watcher, "recursive workspace watcher should be available on supported Node hosts")
  await mutate()
  return await watcher.finish()
}

test("workspace watcher fingerprints final file state instead of raw write activity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-workspace-watch-"))
  try {
    const file = path.join(root, "capture.txt")

    const first = await watchMutation(root, async () => {
      await writeFile(file, "first\n")
    })
    assert.match(first.fingerprint, /^workspace:[a-f0-9]{64}$/)
    assert.ok(first.touchedPaths >= 1)

    const same = await watchMutation(root, async () => {
      await writeFile(file, "first\n")
    })
    assert.equal(same.fingerprint, first.fingerprint, "rewriting identical small-file bytes should deduplicate")

    const changed = await watchMutation(root, async () => {
      await writeFile(file, "second\n")
    })
    assert.notEqual(changed.fingerprint, first.fingerprint, "new final file bytes should produce new progress state")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("large-file sampling deduplicates identical rewrites and observes sampled middle changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-workspace-large-"))
  try {
    const file = path.join(root, "capture.png")
    const original = Buffer.alloc(96 * 1024, 0x61)

    const first = await watchMutation(root, async () => {
      await writeFile(file, original)
    })
    assert.match(first.fingerprint, /^workspace:[a-f0-9]{64}$/)

    const same = await watchMutation(root, async () => {
      await writeFile(file, original)
    })
    assert.equal(same.fingerprint, first.fingerprint, "mtime-only churn must not manufacture large-file progress")

    const changedBytes = Buffer.from(original)
    changedBytes.fill(0x62, 48 * 1024, 52 * 1024)
    const changed = await watchMutation(root, async () => {
      await writeFile(file, changedBytes)
    })
    assert.notEqual(changed.fingerprint, first.fingerprint, "middle sample changes should produce new workspace state")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace watcher ignores Goal persistence internals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-workspace-ignore-"))
  try {
    const result = await watchMutation(root, async () => {
      const goalDir = path.join(root, ".opencode", "goals")
      const lockDir = path.join(root, ".opencode", "goal-locks")
      const sequenceDir = path.join(root, ".opencode", "goal-sequences")
      await mkdir(goalDir, { recursive: true })
      await mkdir(lockDir, { recursive: true })
      await mkdir(sequenceDir, { recursive: true })
      await writeFile(path.join(goalDir, "state.json"), "{}\n")
      await writeFile(path.join(lockDir, "state.lock"), "{}\n")
      await writeFile(path.join(sequenceDir, "state.json"), "{}\n")
    })

    assert.equal(result.fingerprint, undefined)
    assert.equal(result.touchedPaths, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace watcher does not treat external symlink target writes as project mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-workspace-link-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-workspace-outside-"))
  try {
    const external = path.join(outside, "outside.txt")
    await writeFile(external, "first\n")
    const link = path.join(root, "external-link.txt")
    try {
      await import("node:fs/promises").then(({ symlink }) => symlink(external, link))
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("symlink creation is not permitted on this Windows runner")
        return
      }
      throw error
    }

    const watcher = await beginWorkspaceMutationWatch(root)
    assert.ok(watcher)
    await writeFile(external, "second\n")
    const result = await watcher.finish()
    assert.equal(result.fingerprint, undefined, "external target writes must not become project progress")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
