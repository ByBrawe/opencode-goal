import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectMutationFingerprints } from "../dist/runtime/mutation-progress.js"

test("write progress fingerprints actual file bytes so identical rewrites deduplicate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-mutation-"))
  try {
    const file = path.join(root, "result.txt")
    await writeFile(file, "first\n")
    const first = await collectMutationFingerprints({ root, tool: "write", args: { filePath: file }, metadata: { filepath: file } })
    assert.equal(first.length, 1)
    assert.match(first[0].fingerprint, /^file:result\.txt:[a-f0-9]{64}$/)

    const same = await collectMutationFingerprints({ root, tool: "write", args: { filePath: file }, metadata: { filepath: file } })
    assert.equal(same[0].fingerprint, first[0].fingerprint)

    await writeFile(file, "second\n")
    const changed = await collectMutationFingerprints({ root, tool: "write", args: { filePath: file }, metadata: { filepath: file } })
    assert.notEqual(changed[0].fingerprint, first[0].fingerprint)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Goal persistence and queue files never count as project mutation progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-control-plane-"))
  try {
    const internal = [
      path.join(root, ".opencode", "goals", "state.json"),
      path.join(root, ".opencode", "goal-locks", "state.lock"),
      path.join(root, ".opencode", "goal-sequences", "queue.json"),
    ]
    for (const file of internal) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, "state\n")
      assert.deepEqual(
        await collectMutationFingerprints({ root, tool: "write", args: { filePath: file }, metadata: { filepath: file } }),
        [],
        `${file} is Goal control-plane state, not user project progress`,
      )
    }

    const command = path.join(root, ".opencode", "commands", "project-command.md")
    await mkdir(path.dirname(command), { recursive: true })
    await writeFile(command, "project owned\n")
    const visible = await collectMutationFingerprints({ root, tool: "write", args: { filePath: command }, metadata: { filepath: command } })
    assert.equal(visible.length, 1, "the guard must not blanket-ignore project-owned .opencode files")
    assert.match(visible[0].fingerprint, /^file:\.opencode\/commands\/project-command\.md:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("mutation progress ignores files outside the project including symlink escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-root-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-outside-"))
  try {
    const external = path.join(outside, "secret.txt")
    await writeFile(external, "secret\n")
    assert.deepEqual(await collectMutationFingerprints({ root, tool: "write", args: { filePath: external }, metadata: { filepath: external } }), [])

    const link = path.join(root, "escape.txt")
    try {
      await import("node:fs/promises").then(({ symlink }) => symlink(external, link))
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("symlink creation is not permitted on this Windows runner")
        return
      }
      throw error
    }
    assert.deepEqual(await collectMutationFingerprints({ root, tool: "write", args: { filePath: link }, metadata: { filepath: link } }), [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("apply_patch deletion produces a stable project-local deletion fingerprint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-delete-"))
  try {
    const file = path.join(root, "gone.txt")
    const result = await collectMutationFingerprints({
      root,
      tool: "apply_patch",
      metadata: { files: [{ filePath: file, type: "delete" }] },
    })
    assert.deepEqual(result, [{ fingerprint: "file:gone.txt:deleted", summary: "Project file deleted: gone.txt" }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
