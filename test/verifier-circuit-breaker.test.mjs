import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function stateFor(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function createGoal(hooks, objective, sessionID = "parent") {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: objective }, output)
  return output
}

test("verifier infrastructure failure pauses the Goal and prevents idle retry loops", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-verifier-circuit-"))
  let parentPromptCalls = 0
  let createCalls = 0
  try {
    const client = {
      session: {
        async create() {
          createCalls += 1
          throw new Error("verifier provider unavailable")
        },
        async prompt() {
          parentPromptCalls += 1
          return {}
        },
        async abort() { return true },
        async delete() { return true },
      },
    }
    const hooks = await OpenCodeGoalPlugin({ client, directory: root })
    await createGoal(hooks, "finish the requested work")

    const first = await hooks.tool.opencode_goal_complete.execute(
      { summary: "done" },
      { sessionID: "parent", messageID: "executor-current", agent: "build" },
    )
    assert.match(first, /Completion not verified:/)
    assert.match(first, /Goal paused to prevent repeated verifier retries/)
    assert.equal(createCalls, 1, "non-timeout verifier infrastructure failures must not be retried automatically")

    const paused = await stateFor(root)
    assert.equal(paused.status, "paused")
    assert.match(paused.stopReason, /Independent semantic verification unavailable/)
    assert.match(paused.stopReason, /verifier provider unavailable/)

    const second = await hooks.tool.opencode_goal_complete.execute(
      { summary: "retry" },
      { sessionID: "parent", messageID: "executor-current", agent: "build" },
    )
    assert.match(second, /goal status is paused/)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(parentPromptCalls, 0, "paused verifier failure must not dispatch a fresh continuation on idle")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("semantic verifier timeout gets exactly one fresh retry before the circuit breaker pauses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-verifier-timeout-retry-"))
  let createCalls = 0
  try {
    const client = {
      session: {
        async create() {
          createCalls += 1
          return await new Promise(() => {})
        },
        async prompt() { return {} },
        async abort() { return true },
        async delete() { return true },
      },
    }
    const hooks = await OpenCodeGoalPlugin(
      { client, directory: root },
      { verifierTimeoutMs: 15 },
    )
    await createGoal(hooks, "finish the requested work")

    const result = await hooks.tool.opencode_goal_complete.execute(
      { summary: "done" },
      { sessionID: "parent", messageID: "executor-current", agent: "build" },
    )

    assert.match(result, /Completion not verified:/)
    assert.match(result, /after one automatic timeout retry/)
    assert.equal(createCalls, 2, "a verifier timeout should get one fresh session attempt, never an unbounded retry loop")

    const paused = await stateFor(root)
    assert.equal(paused.status, "paused")
    assert.match(paused.stopReason, /after one automatic timeout retry/)
    assert.match(paused.stopReason, /timed out after 15ms/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
