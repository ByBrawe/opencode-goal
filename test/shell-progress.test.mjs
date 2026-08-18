import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, { shellActivityFingerprint } from "../dist/index.js"

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
  }
}

async function readOnlyGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function createGoal(hooks, sessionID = "session-1") {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "run a shell-heavy research pipeline" },
    output,
  )
  assert.match(output.parts[0].text, /Continue working toward the active OpenCode goal/)
}

async function runShell(hooks, { sessionID = "session-1", callID, command }) {
  const beforeOutput = { args: { command } }
  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID }, beforeOutput)
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID, callID, args: { command } },
    { title: "bash", output: "completed", metadata: {} },
  )
}

test("shell activity fingerprint normalizes CRLF and never exposes command text", () => {
  const one = shellActivityFingerprint({ command: "npm run quality\r\n" })
  const two = shellActivityFingerprint({ command: "npm run quality\n" })
  assert.equal(one, two)
  assert.match(one, /^shell:[a-f0-9]{64}$/)
  assert.doesNotMatch(one, /npm run quality/)
  assert.equal(shellActivityFingerprint({ command: "   " }), undefined)
})

test("distinct Goal-owned shell actions count as host progress while identical repeats deduplicate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-progress-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)

    const before = await readOnlyGoal(root)
    await runShell(hooks, { callID: "shell-1", command: "npm run quality -- --token TOP_SECRET" })

    let goal = await readOnlyGoal(root)
    assert.equal(goal.progressRevision, before.progressRevision + 1)
    assert.match(goal.progressNotes.at(-1).summary, /Goal-owned shell command completed/)
    assert.doesNotMatch(JSON.stringify(goal.progressNotes), /TOP_SECRET/)
    assert.doesNotMatch(JSON.stringify(goal.progressFingerprints), /TOP_SECRET/)

    await runShell(hooks, { callID: "shell-2", command: "npm run quality -- --token TOP_SECRET" })
    goal = await readOnlyGoal(root)
    assert.equal(goal.progressRevision, before.progressRevision + 1, "the same shell action must not manufacture repeated progress")

    await runShell(hooks, { callID: "shell-3", command: "npm run typecheck" })
    goal = await readOnlyGoal(root)
    assert.equal(goal.progressRevision, before.progressRevision + 2, "a distinct completed shell action counts once")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("shell completion from an older Goal revision cannot mark the edited Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-stale-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)

    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "session-1", callID: "old-shell" },
      { args: { command: "npm run long-generator" } },
    )

    const editOutput = { parts: [{ type: "text", text: "raw edit" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "session-1", arguments: "edit run the revised research pipeline" },
      editOutput,
    )
    const edited = await readOnlyGoal(root)
    assert.equal(edited.revision, 2)

    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "session-1", callID: "old-shell", args: { command: "npm run long-generator" } },
      { title: "bash", output: "completed late", metadata: {} },
    )

    const after = await readOnlyGoal(root)
    assert.equal(after.revision, 2)
    assert.equal(after.progressRevision, edited.progressRevision, "stale shell work must not mutate the new Goal revision")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
