import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
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

async function readOnlyGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function fakeClient() {
  let promptCount = 0
  let abortCount = 0
  const prompts = []
  const pending = []
  return {
    client: {
      session: {
        prompt(arg) {
          promptCount += 1
          prompts.push(arg)
          return new Promise((resolve, reject) => pending.push({ resolve, reject }))
        },
        abort() {
          abortCount += 1
          return Promise.resolve(true)
        },
      },
    },
    get promptCount() { return promptCount },
    get abortCount() { return abortCount },
    prompts,
    pending,
  }
}

async function createGoalThroughCommand(hooks, sessionID = "session-1") {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: 'ship release --check "node -e \\"process.exit(0)\\""' },
    output,
  )
  assert.match(output.parts[0].text, /Continue working toward the active OpenCode goal/)
  return output
}

test("command-owned chat message does not pause its own goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-adapter-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await createGoalThroughCommand(hooks)
    await hooks["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "p", modelID: "m" }, variant: "high" },
      { parts: output.parts },
    )
    const goal = await readOnlyGoal(root)
    assert.equal(goal.status, "active")
    assert.deepEqual(goal.execution, { agent: "build", model: { providerID: "p", modelID: "m" }, variant: "high" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("human message pauses active goal and aborts an in-flight continuation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-interrupt-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await createGoalThroughCommand(hooks)
    await hooks["chat.message"]({ sessionID: "session-1", agent: "build" }, { parts: output.parts })

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await tick()
    assert.equal(fake.promptCount, 1)

    await hooks["chat.message"]({ sessionID: "session-1", agent: "build" }, { parts: [{ type: "text", text: "stop and do something else" }] })
    await tick()
    const goal = await readOnlyGoal(root)
    assert.equal(goal.status, "paused")
    assert.match(goal.stopReason, /user sent a new message/i)
    assert.equal(fake.abortCount, 1)
    fake.pending[0].resolve({})
    await tick()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("duplicate idle while prompt is pending does not dispatch concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-idle-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await createGoalThroughCommand(hooks)
    await hooks["chat.message"]({ sessionID: "session-1", agent: "build" }, { parts: output.parts })

    await Promise.all([
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } }),
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } }),
    ])
    await tick()
    assert.equal(fake.promptCount, 1)

    fake.pending[0].resolve({})
    await waitFor(() => fake.promptCount === 2)
    assert.equal(fake.promptCount, 2, "deferred idle is replayed only after the first dispatch settles")
    fake.pending[1].resolve({})
    await tick()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("mutating OpenCode tool activity counts as host-observed progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-tool-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await createGoalThroughCommand(hooks)
    await hooks["chat.message"]({ sessionID: "session-1", agent: "build" }, { parts: output.parts })
    const before = await readOnlyGoal(root)
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: "session-1", callID: "call-1", args: {} }, { title: "", output: "", metadata: {} })
    const after = await readOnlyGoal(root)
    assert.equal(after.progressRevision, before.progressRevision + 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("active goal owns compaction context and generic auto-continue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-compact-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createGoalThroughCommand(hooks)
    const compact = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "session-1" }, compact)
    assert.equal(compact.context.length, 1)
    assert.match(compact.context[0], /Persistent OpenCode goal state/)
    const auto = { enabled: true }
    await hooks["experimental.compaction.autocontinue"]({ sessionID: "session-1" }, auto)
    assert.equal(auto.enabled, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
