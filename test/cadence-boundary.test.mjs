import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function readGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

test("explicit cadence rejects a second successful file mutation in the same Goal turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-cadence-boundary-"))
  try {
    await writeFile(path.join(root, "1.json"), '{"value":10}\n')
    const client = { session: { async prompt() { return {} } } }
    const hooks = await OpenCodeGoalPlugin({ client, directory: root })

    const output = { parts: [{ type: "text", text: "raw" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "s1", arguments: "10 ayrı goal turu boyunca her goal turunda 1.json value değerini tam 1 artır" },
      output,
    )
    await hooks["chat.message"](
      { sessionID: "s1", messageID: "u1", agent: "build" },
      { message: { id: "u1" }, parts: output.parts },
    )

    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "s1", callID: "call-1" })
    await writeFile(path.join(root, "1.json"), '{"value":11}\n')
    await hooks["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "call-1", args: { filePath: "1.json" } },
      { metadata: { filepath: "1.json" } },
    )

    await assert.rejects(
      hooks["tool.execute.before"]({ tool: "edit", sessionID: "s1", callID: "call-2" }),
      /Goal cadence boundary/,
    )

    const afterFirst = await readGoal(root)
    assert.equal(afterFirst.progressRevision, 1)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    await tick()

    await assert.doesNotReject(
      hooks["tool.execute.before"]({ tool: "edit", sessionID: "s1", callID: "call-3" }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
