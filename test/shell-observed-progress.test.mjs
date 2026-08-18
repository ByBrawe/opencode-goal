import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, {
  shellObservationFingerprint,
  shellResultFingerprint,
} from "../dist/index.js"

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function readGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function createGoal(hooks) {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID: "s1", arguments: "capture batches until the research corpus is complete" },
    output,
  )
}

async function closeTurn(hooks) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  await tick()
}

async function runShell(hooks, { callID, command, output = "batch complete", mutate }) {
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID })
  if (mutate) await mutate()
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID: "s1", callID, args: { command } },
    { title: "bash", output, metadata: { exit: 0, output } },
  )
}

test("shell observation/result fingerprints are secret-safe and react to new host evidence", () => {
  const args = { command: "npm run audit -- --token TOP_SECRET" }
  const firstOutput = { metadata: { exit: 0, output: "PRIVATE_RESULT" } }
  const observation = shellObservationFingerprint(args, firstOutput)
  assert.match(observation, /^shell-observation:[a-f0-9]{64}$/)
  assert.doesNotMatch(observation, /TOP_SECRET|PRIVATE_RESULT/)

  assert.notEqual(
    shellObservationFingerprint(args, { metadata: { exit: 0, output: "NEW_RESULT" } }),
    observation,
  )
  assert.notEqual(
    shellResultFingerprint(args, firstOutput, "workspace:one"),
    shellResultFingerprint(args, firstOutput, "workspace:two"),
  )
})

test("same shell command and output can make fresh progress when workspace state changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-shell-observed-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    await createGoal(hooks)
    await closeTurn(hooks)

    const captures = path.join(root, "captures")
    await mkdir(captures, { recursive: true })
    const command = "node tooling/capture.mjs --next-batch"

    let previousRevision = (await readGoal(root)).progressRevision
    for (let index = 0; index < 3; index += 1) {
      await runShell(hooks, {
        callID: `capture-${index + 1}`,
        command,
        output: "batch complete",
        mutate: async () => {
          await writeFile(path.join(captures, `shot-${index + 1}.png`), `capture-${index + 1}\n`)
        },
      })
      await closeTurn(hooks)
      const goal = await readGoal(root)
      assert.equal(goal.status, "active")
      assert.equal(goal.stalledTurns, 0)
      assert.ok(goal.progressRevision > previousRevision, "new workspace state must produce fresh host progress")
      assert.equal(goal.observedProgressRevision, goal.progressRevision)
      previousRevision = goal.progressRevision
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
