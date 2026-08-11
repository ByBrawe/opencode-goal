import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function readGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

test("fast edit before assistant message.updated still records host progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-fast-tool-progress-"))
  try {
    await writeFile(path.join(root, "1.json"), '{"value":10}\n')
    const client = { session: { async prompt() { return {} } } }
    const hooks = await OpenCodeGoalPlugin({ client, directory: root })

    const output = { parts: [{ type: "text", text: "raw" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "s1", arguments: "increment 1.json once" },
      output,
    )
    await hooks["chat.message"](
      { sessionID: "s1", messageID: "u1", agent: "build" },
      { message: { id: "u1" }, parts: output.parts },
    )

    // Reproduce the fast-provider ordering: the tool hook arrives before any
    // assistant message.updated event has established activeBySession ownership.
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "s1", callID: "call-1" })
    await writeFile(path.join(root, "1.json"), '{"value":11}\n')
    await hooks["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "call-1", args: { filePath: "1.json" } },
      { metadata: { filepath: "1.json" } },
    )

    const goal = await readGoal(root)
    assert.equal(goal.status, "active")
    assert.equal(goal.progressRevision, 1)
    assert.match(goal.progressNotes.at(-1)?.summary ?? "", /1\.json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
