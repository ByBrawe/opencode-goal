import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function state(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function bind(hooks, output, revision) {
  const user = `user-r${revision}`
  const assistant = `assistant-r${revision}`
  await hooks["chat.message"]({ sessionID: "s1", messageID: user, agent: "build" }, { message: { id: user }, parts: output.parts })
  await hooks.event({ event: { type: "message.updated", properties: { info: {
    id: assistant, sessionID: "s1", parentID: user, role: "assistant",
    time: { created: Date.now() }, tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0,
  } } } })
  return assistant
}

test("old revision file tool completion cannot advance an edited goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-stale-tool-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ directory: root, client: { session: {
      async abort() { return true }, async prompt() { return {} },
    } } })
    const initial = { parts: [{ type: "text", text: "raw" }] }
    await hooks["command.execute.before"]({ command: "goal", sessionID: "s1", arguments: "old objective" }, initial)
    const oldMessage = await bind(hooks, initial, 1)
    const file = path.join(root, "result.txt")
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      type: "tool", sessionID: "s1", messageID: oldMessage, callID: "old-write", tool: "write", state: { status: "running" },
    } } } })
    await hooks["tool.execute.before"]({ tool: "write", sessionID: "s1", callID: "old-write" }, { args: { filePath: file } })

    const edited = { parts: [{ type: "text", text: "edit" }] }
    await hooks["command.execute.before"]({ command: "goal", sessionID: "s1", arguments: "edit new objective" }, edited)
    const afterEdit = await state(root)
    assert.equal(afterEdit.revision, 2)

    await writeFile(file, "late old revision\n")
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: "s1", callID: "old-write", args: { filePath: file } },
      { metadata: { filepath: file } },
    )
    const stale = await state(root)
    assert.equal(stale.progressRevision, afterEdit.progressRevision)
    assert.deepEqual(stale.progressFingerprints, [])

    const currentMessage = await bind(hooks, edited, 2)
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      type: "tool", sessionID: "s1", messageID: currentMessage, callID: "new-write", tool: "write", state: { status: "running" },
    } } } })
    await hooks["tool.execute.before"]({ tool: "write", sessionID: "s1", callID: "new-write" }, { args: { filePath: file } })
    await writeFile(file, "current revision\n")
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: "s1", callID: "new-write", args: { filePath: file } },
      { metadata: { filepath: file } },
    )
    const current = await state(root)
    assert.equal(current.progressRevision, afterEdit.progressRevision + 1)
    assert.equal(current.progressFingerprints.length, 1)
    assert.match(current.progressFingerprints[0], /^file:result\.txt:[a-f0-9]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
