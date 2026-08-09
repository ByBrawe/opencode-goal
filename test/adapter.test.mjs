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

async function bindGoalTurn(hooks, output, {
  sessionID = "session-1",
  userMessageID = "user-r1",
  assistantMessageID = "assistant-r1",
} = {}) {
  await hooks["chat.message"](
    { sessionID, messageID: userMessageID, agent: "build", model: { providerID: "p", modelID: "m" }, variant: "high" },
    { message: { id: userMessageID }, parts: output.parts },
  )
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          parentID: userMessageID,
          role: "assistant",
          time: { created: Date.now() },
          tokens: { input: 0, output: 0, reasoning: 0 },
          cost: 0,
        },
      },
    },
  })
}

async function emitPatch(hooks, {
  sessionID = "session-1",
  assistantMessageID = "assistant-r1",
  hash = "patch-1",
  files = ["src/a.ts"],
} = {}) {
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: { type: "patch", sessionID, messageID: assistantMessageID, hash, files },
      },
    },
  })
}

test("command-owned chat message does not pause its own goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-adapter-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await createGoalThroughCommand(hooks)
    await hooks["chat.message"](
      { sessionID: "session-1", messageID: "user-r1", agent: "build", model: { providerID: "p", modelID: "m" }, variant: "high" },
      { message: { id: "user-r1" }, parts: output.parts },
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
    await hooks["chat.message"]({ sessionID: "session-1", messageID: "user-r1", agent: "build" }, { message: { id: "user-r1" }, parts: output.parts })

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await tick()
    assert.equal(fake.promptCount, 1)

    await hooks["chat.message"]({ sessionID: "session-1", messageID: "human-2", agent: "build" }, { message: { id: "human-2" }, parts: [{ type: "text", text: "stop and do something else" }] })
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
    await hooks["chat.message"]({ sessionID: "session-1", messageID: "user-r1", agent: "build" }, { message: { id: "user-r1" }, parts: output.parts })

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

test("revision-owned PatchPart remains a fallback host-progress signal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-patch-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await createGoalThroughCommand(hooks)
    await bindGoalTurn(hooks, output)

    const before = await readOnlyGoal(root)
    assert.equal(typeof hooks["tool.execute.after"], "function", "owned file mutations may also produce content-hash progress")

    await emitPatch(hooks)
    const changed = await readOnlyGoal(root)
    assert.equal(changed.progressRevision, before.progressRevision + 1)
    assert.deepEqual(changed.progressFingerprints, ["patch:patch-1"])

    await emitPatch(hooks)
    const duplicate = await readOnlyGoal(root)
    assert.equal(duplicate.progressRevision, changed.progressRevision, "duplicate patch delivery must not double-count progress")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("goal edit aborts the old turn, suppresses abort-idle, and rejects stale revision activity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-steer-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const original = await createGoalThroughCommand(hooks)
    await bindGoalTurn(hooks, original)

    const editOutput = { parts: [{ type: "text", text: "edit args" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "session-1", arguments: "edit ship revised release" },
      editOutput,
    )
    assert.equal(fake.abortCount, 1, "editing an active goal-owned turn must abort the old OpenCode run")
    let revised = await readOnlyGoal(root)
    assert.equal(revised.revision, 2)
    assert.equal(revised.objective, "ship revised release")
    const afterEditProgress = revised.progressRevision

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    await tick()
    assert.equal(fake.promptCount, 0, "idle emitted by the steering abort must not create a duplicate continuation")

    await emitPatch(hooks, { assistantMessageID: "assistant-r1", hash: "old-revision-patch", files: ["old.ts"] })
    revised = await readOnlyGoal(root)
    assert.equal(revised.progressRevision, afterEditProgress, "old revision patch must not count for the edited goal")

    const staleProgress = await hooks.tool.opencode_goal_progress.execute(
      { summary: "old turn claims progress", next: "continue" },
      { sessionID: "session-1", messageID: "assistant-r1", agent: "build" },
    )
    assert.match(staleProgress, /older goal revision/i)

    await bindGoalTurn(hooks, editOutput, { userMessageID: "user-r2", assistantMessageID: "assistant-r2" })
    await emitPatch(hooks, { assistantMessageID: "assistant-r2", hash: "new-revision-patch", files: ["new.ts"] })
    revised = await readOnlyGoal(root)
    assert.equal(revised.progressRevision, afterEditProgress + 1)
    assert.deepEqual(revised.progressFingerprints, ["patch:new-revision-patch"])

    const currentProgress = await hooks.tool.opencode_goal_progress.execute(
      { summary: "new turn checkpoint", next: "verify" },
      { sessionID: "session-1", messageID: "assistant-r2", agent: "build" },
    )
    assert.match(currentProgress, /Checkpoint recorded/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("non-goal assistant messages do not consume goal budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-usage-owner-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await createGoalThroughCommand(hooks)
    await bindGoalTurn(hooks, output)

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-r1",
            sessionID: "session-1",
            parentID: "user-r1",
            role: "assistant",
            time: { created: 1, completed: 11 },
            tokens: { input: 10, output: 5, reasoning: 2 },
            cost: 0.01,
          },
        },
      },
    })
    const afterGoalTurn = await readOnlyGoal(root)
    assert.equal(afterGoalTurn.usage.turns, 1)

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-human",
            sessionID: "session-1",
            parentID: "human-user",
            role: "assistant",
            time: { created: 20, completed: 30 },
            tokens: { input: 1000, output: 1000, reasoning: 1000 },
            cost: 99,
          },
        },
      },
    })
    const afterHumanTurn = await readOnlyGoal(root)
    assert.equal(afterHumanTurn.usage.turns, 1)
    assert.equal(afterHumanTurn.usage.cost, afterGoalTurn.usage.cost)
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
