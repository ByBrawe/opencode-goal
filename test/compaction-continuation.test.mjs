import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("condition was not met before timeout")
}

function fakeClient() {
  let abortCount = 0
  const prompts = []
  const pending = []
  return {
    client: {
      session: {
        prompt(arg) {
          prompts.push(arg)
          return new Promise((resolve, reject) => pending.push({ resolve, reject }))
        },
        abort() {
          abortCount += 1
          return Promise.resolve(true)
        },
      },
    },
    get promptCount() { return prompts.length },
    get abortCount() { return abortCount },
    prompts,
    pending,
  }
}

async function createAndBindGoal(hooks, sessionID = "session-compact") {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "finish the compaction-safe work" },
    output,
  )
  await hooks["chat.message"](
    { sessionID, messageID: "user-initial", agent: "build", model: { providerID: "p", modelID: "m" } },
    { message: { id: "user-initial" }, parts: output.parts },
  )
}

async function finishContinuationTurn(hooks, fake, sessionID = "session-compact") {
  const userMessageID = "user-after-compact"
  await hooks["chat.message"](
    { sessionID, messageID: userMessageID, agent: "build", model: { providerID: "p", modelID: "m" } },
    { message: { id: userMessageID }, parts: fake.prompts[0].body.parts },
  )
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-after-compact",
          sessionID,
          parentID: userMessageID,
          role: "assistant",
          time: { created: 100, completed: 200 },
          tokens: { input: 10, output: 2, reasoning: 0 },
          cost: 0,
        },
      },
    },
  })
  fake.pending[0].resolve({})
  await tick()
}

test("successful compaction guarantees exactly one Goal continuation without requiring host idle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-compaction-continuation-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndBindGoal(hooks)

    const compact = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "session-compact" }, compact)
    assert.equal(compact.context.length, 1)

    const auto = { enabled: true }
    await hooks["experimental.compaction.autocontinue"]({ sessionID: "session-compact" }, auto)
    assert.equal(auto.enabled, false, "active Goal keeps generic OpenCode post-compaction continue disabled")

    await waitFor(() => fake.promptCount === 1)
    assert.equal(fake.promptCount, 1, "successful compaction must schedule the Goal-owned continuation even without session.idle")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-compact" } } })
    await tick()
    assert.equal(fake.promptCount, 1, "late compaction idle must not queue a duplicate continuation")

    await finishContinuationTurn(hooks, fake)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-compact" } } })
    await tick()
    assert.equal(fake.promptCount, 2, "ordinary Goal idle continuation resumes after the compacted turn starts")
    fake.pending[1].resolve({})
    await tick()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("post-compaction continuation still obeys delegated-task deferral", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-compaction-task-deferral-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndBindGoal(hooks)

    await hooks["tool.execute.before"]({
      sessionID: "session-compact",
      callID: "task-call",
      tool: "task",
      args: {},
    })

    const auto = { enabled: true }
    await hooks["experimental.compaction.autocontinue"]({ sessionID: "session-compact" }, auto)
    assert.equal(auto.enabled, false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(fake.promptCount, 0, "coordinator must not bypass an active delegated task")

    await hooks["tool.execute.after"](
      { sessionID: "session-compact", callID: "task-call", tool: "task", args: {} },
      { output: "task complete", metadata: {} },
    )
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-compact" } } })
    await waitFor(() => fake.promptCount === 1)
    assert.equal(fake.promptCount, 1, "the first safe parent idle claims the pending compaction continuation")
    fake.pending[0].resolve({})
    await tick()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("inactive Goals do not acquire compaction continuation ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-compaction-inactive-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndBindGoal(hooks)

    const pause = { parts: [{ type: "text", text: "pause" }] }
    await hooks["command.execute.before"]({ command: "goal", sessionID: "session-compact", arguments: "pause" }, pause)

    const auto = { enabled: true }
    await hooks["experimental.compaction.autocontinue"]({ sessionID: "session-compact" }, auto)
    await tick()
    assert.equal(auto.enabled, true)
    assert.equal(fake.promptCount, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
