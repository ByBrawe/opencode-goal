import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, {
  assistantInfoHasMeaningfulActivity,
  assistantPartHasMeaningfulActivity,
  createGoal,
  recordEmptyAssistantTurn,
  resumeGoal,
} from "../dist/index.js"

async function tick(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function readOnlyGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function fakeClient() {
  const prompts = []
  const pending = []
  const toasts = []
  return {
    client: {
      session: {
        prompt(arg) {
          prompts.push(arg)
          return new Promise((resolve, reject) => pending.push({ resolve, reject }))
        },
        abort() {
          return Promise.resolve(true)
        },
      },
      tui: {
        showToast(arg) {
          toasts.push(arg)
          return Promise.resolve({})
        },
      },
    },
    prompts,
    pending,
    toasts,
  }
}

async function createAndBindGoal(hooks, {
  sessionID = "empty-goal",
  userMessageID = "user-r1",
  assistantMessageID = "assistant-r1",
} = {}) {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({
    command: "goal",
    sessionID,
    arguments: "finish the repository reliability work",
  }, output)
  await hooks["chat.message"]({
    sessionID,
    messageID: userMessageID,
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  }, {
    message: { id: userMessageID },
    parts: output.parts,
  })
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          parentID: userMessageID,
          role: "assistant",
          time: { created: 10 },
          tokens: { input: 0, output: 0, reasoning: 0 },
          cost: 0,
        },
      },
    },
  })
}

async function completeAssistant(hooks, {
  sessionID = "empty-goal",
  userMessageID,
  assistantMessageID,
  created = 10,
  completed = 20,
  input = 10,
  output = 0,
  reasoning = 0,
  cost = 0.001,
} = {}) {
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          parentID: userMessageID,
          role: "assistant",
          time: { created, completed },
          tokens: { input, output, reasoning },
          cost,
        },
      },
    },
  })
}

test("meaningful assistant activity distinguishes blank tails from real text/tool/file/patch/artifact work", () => {
  assert.equal(assistantPartHasMeaningfulActivity({ type: "text", text: "" }), false)
  assert.equal(assistantPartHasMeaningfulActivity({ type: "text", text: "   \n" }), false)
  assert.equal(assistantPartHasMeaningfulActivity({ type: "text", text: "done" }), true)
  for (const type of ["tool", "file", "patch", "artifact"]) {
    assert.equal(assistantPartHasMeaningfulActivity({ type }), true, `${type} activity must be meaningful`)
  }
  assert.equal(assistantPartHasMeaningfulActivity({ type: "reasoning", text: "private thought" }), false)
  assert.equal(assistantInfoHasMeaningfulActivity({ content: "answer" }), true)
  assert.equal(assistantInfoHasMeaningfulActivity({ summary: true }), false)
})

test("empty assistant attempts preserve token/cost/runtime usage but refund logical Goal turns", () => {
  let goal = createGoal({ sessionID: "pure-empty", objective: "finish work", now: 1 })
  goal = recordEmptyAssistantTurn(goal, {
    messageID: "a1",
    inputTokens: 100,
    outputTokens: 0,
    reasoningTokens: 5,
    cost: 0.25,
    createdAt: 10,
    completedAt: 30,
  }, { now: 40 })
  assert.equal(goal.status, "active")
  assert.equal(goal.emptyTurnCount, 1)
  assert.equal(goal.usage.turns, 0)
  assert.equal(goal.usage.tokens, 105)
  assert.equal(goal.usage.cost, 0.25)
  assert.equal(goal.usage.runtimeMs, 20)
  assert.deepEqual(goal.usage.seenMessageIDs, ["a1"])
  assert.equal(goal.skipNextStallCheck, true)

  goal = recordEmptyAssistantTurn(goal, {
    messageID: "a2",
    inputTokens: 50,
    cost: 0.1,
    createdAt: 50,
    completedAt: 80,
  }, { now: 90 })
  assert.equal(goal.status, "paused")
  assert.equal(goal.emptyTurnCount, 2)
  assert.equal(goal.usage.turns, 0)
  assert.equal(goal.usage.tokens, 155)
  assert.equal(goal.usage.cost, 0.35)
  assert.equal(goal.usage.runtimeMs, 50)
  assert.match(goal.stopReason, /2 consecutive Goal-owned assistant turns/)
  assert.equal(goal.skipNextStallCheck, undefined)

  const resumed = resumeGoal(goal, 100)
  assert.equal(resumed.status, "active")
  assert.equal(resumed.emptyTurnCount, undefined)
  assert.equal(resumed.lastEmptyTurnAt, undefined)
})

test("two consecutive completed-but-empty Goal turns retry once then pause without consuming turn budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-empty-turn-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndBindGoal(hooks)

    await completeAssistant(hooks, {
      userMessageID: "user-r1",
      assistantMessageID: "assistant-r1",
      input: 100,
      cost: 0.01,
    })

    let goal = await readOnlyGoal(root)
    assert.equal(goal.status, "active")
    assert.equal(goal.emptyTurnCount, 1)
    assert.equal(goal.usage.turns, 0)
    assert.equal(goal.usage.tokens, 100)
    assert.equal(goal.stalledTurns, 0)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "empty-goal" } } })
    await tick()
    assert.equal(fake.prompts.length, 1, "first empty completion gets exactly one bounded retry")

    await hooks["chat.message"]({
      sessionID: "empty-goal",
      messageID: "user-r2",
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    }, {
      message: { id: "user-r2" },
      parts: fake.prompts[0].body.parts,
    })
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-r2",
            sessionID: "empty-goal",
            parentID: "user-r2",
            role: "assistant",
            time: { created: 30 },
            tokens: { input: 0, output: 0, reasoning: 0 },
            cost: 0,
          },
        },
      },
    })
    await completeAssistant(hooks, {
      userMessageID: "user-r2",
      assistantMessageID: "assistant-r2",
      created: 30,
      completed: 50,
      input: 200,
      cost: 0.02,
    })
    fake.pending[0].resolve({})
    await tick()

    goal = await readOnlyGoal(root)
    assert.equal(goal.status, "paused")
    assert.equal(goal.emptyTurnCount, 2)
    assert.equal(goal.usage.turns, 0, "empty replies must not consume --max-turns")
    assert.equal(goal.usage.tokens, 300, "actual provider token spend remains visible")
    assert.equal(goal.usage.cost, 0.03)
    assert.match(goal.stopReason, /without meaningful text or tool\/file\/patch\/artifact activity/)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "empty-goal" } } })
    await tick()
    assert.equal(fake.prompts.length, 1, "paused empty-turn fail-safe must stop autonomous dispatch")
    const emptyToasts = fake.toasts
      .map((item) => item?.body?.message)
      .filter((message) => typeof message === "string" && (/no meaningful activity/i.test(message) || /empty assistant turns/i.test(message)))
    assert.equal(emptyToasts.length, 2, "first empty retry and second empty pause must both be visible")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test("tool activity followed by a blank final assistant tail is meaningful and clears the empty streak", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-tool-blank-tail-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndBindGoal(hooks)

    await completeAssistant(hooks, {
      userMessageID: "user-r1",
      assistantMessageID: "assistant-r1",
      input: 40,
    })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "empty-goal" } } })
    await tick()

    await hooks["chat.message"]({
      sessionID: "empty-goal",
      messageID: "user-r2",
      agent: "build",
    }, {
      message: { id: "user-r2" },
      parts: fake.prompts[0].body.parts,
    })
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-r2",
            sessionID: "empty-goal",
            parentID: "user-r2",
            role: "assistant",
            time: { created: 30 },
            tokens: { input: 0, output: 0, reasoning: 0 },
            cost: 0,
          },
        },
      },
    })
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "empty-goal",
            messageID: "assistant-r2",
            callID: "tool-r2",
          },
        },
      },
    })
    await completeAssistant(hooks, {
      userMessageID: "user-r2",
      assistantMessageID: "assistant-r2",
      created: 30,
      completed: 60,
      input: 60,
    })
    fake.pending[0].resolve({})
    await tick()

    const goal = await readOnlyGoal(root)
    assert.equal(goal.status, "active")
    assert.equal(goal.emptyTurnCount, undefined)
    assert.equal(goal.lastEmptyTurnAt, undefined)
    assert.equal(goal.usage.turns, 1, "tool-only work is a real logical Goal turn")
    assert.equal(goal.usage.tokens, 100)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})
