import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"

const overflowError = {
  name: "APIError",
  data: {
    providerID: "opencode",
    statusCode: 400,
    isRetryable: false,
    message: "Error from provider (Console): Upstream request failed: [1261] Prompt exceeds max length",
  },
}

async function tick(count = 6) {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function fakeClient() {
  const prompts = []
  const summaries = []
  let aborts = 0
  return {
    client: {
      session: {
        prompt(arg) {
          prompts.push(arg)
          return Promise.resolve({})
        },
        summarize(arg) {
          summaries.push(arg)
          return Promise.resolve({})
        },
        abort() {
          aborts += 1
          return Promise.resolve(true)
        },
      },
    },
    prompts,
    summaries,
    get aborts() { return aborts },
  }
}

async function createBoundGoal(hooks, sessionID) {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: "finish the project" }, output)
  await hooks["chat.message"](
    { sessionID, messageID: "user-r1", agent: "build", model: { providerID: "opencode", modelID: "x-preview-f-free" }, variant: "max" },
    { message: { id: "user-r1" }, parts: output.parts },
  )
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-r1",
          sessionID,
          parentID: "user-r1",
          role: "assistant",
          time: { created: Date.now() },
          tokens: { input: 0, output: 0, reasoning: 0 },
          cost: 0,
        },
      },
    },
  })
}

async function emitOverflow(hooks, sessionID) {
  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID, error: overflowError },
    },
  })
}

test("prompt overflow compacts once, clears stale provider_retry state, and then resumes Goal ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-overflow-"))
  const sessionID = "overflow-session"
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    await createBoundGoal(hooks, sessionID)

    const current = await store.load(sessionID)
    assert.ok(current)
    await store.save({
      ...current,
      stopReason: "Recovering from provider_retry infrastructure failure; automatic retry scheduled.",
      infrastructureRecovery: {
        kind: "provider_retry",
        reason: "OpenCode reported session.status=retry for an active Goal turn.",
        attempt: 1,
        startedAt: 1,
        nextRetryAt: 2,
      },
      skipNextStallCheck: true,
    })

    await emitOverflow(hooks, sessionID)
    await tick()

    const recovered = await store.load(sessionID)
    assert.equal(fake.summaries.length, 1)
    assert.deepEqual(fake.summaries[0], {
      path: { id: sessionID },
      body: { providerID: "opencode", modelID: "x-preview-f-free" },
    })
    assert.equal(recovered.status, "active")
    assert.equal(recovered.infrastructureRecovery, undefined)
    assert.equal(recovered.stopReason, undefined)
    assert.equal(fake.prompts.length, 1, "one post-compaction Goal-owned continuation should be dispatched")
    assert.match(fake.prompts[0].body.parts[0].text, /Continue working toward/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a second prompt overflow before any successful Goal-owned turn fails safe instead of compaction looping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-overflow-loop-"))
  const sessionID = "overflow-loop"
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    await createBoundGoal(hooks, sessionID)

    await emitOverflow(hooks, sessionID)
    await tick()
    assert.equal(fake.summaries.length, 1)

    await emitOverflow(hooks, sessionID)
    await tick()

    const paused = await store.load(sessionID)
    assert.equal(fake.summaries.length, 1, "the same failed recovery episode must never auto-compact twice")
    assert.equal(paused.status, "paused")
    assert.match(paused.stopReason, /Run \/compact, then \/goal resume/)
    assert.equal(paused.infrastructureRecovery, undefined)
    assert.equal(paused.skipNextStallCheck, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
