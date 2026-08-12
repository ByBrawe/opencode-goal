import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function readGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function fakeClient() {
  const prompts = []
  let abortCount = 0
  return {
    client: {
      session: {
        prompt(arg) {
          prompts.push(arg)
          return Promise.resolve({})
        },
        abort() {
          abortCount += 1
          return Promise.resolve(true)
        },
      },
    },
    prompts,
    get abortCount() { return abortCount },
  }
}

async function createAndOwn(hooks, args = "ship release", sessionID = "s1") {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: args }, output)
  await hooks["chat.message"](
    { sessionID, messageID: "user-1", agent: "build", model: { providerID: "p", modelID: "m" }, variant: "high" },
    { message: { id: "user-1" }, parts: output.parts },
  )
  return output
}

async function completeOwnedAssistant(hooks, { sessionID = "s1", id = "assistant-1", parentID = "user-1", tokens = 10, cost = 0.01 } = {}) {
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id,
          sessionID,
          parentID,
          role: "assistant",
          time: { created: 100, completed: 200 },
          tokens: { input: tokens, output: 0, reasoning: 0 },
          cost,
        },
      },
    },
  })
}

test("explicit OpenCode usage limit stops automatic goal retry while generic retry remains active", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-usage-limit-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndOwn(hooks)

    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: { type: "retry", attempt: 1, message: "Too Many Requests", next: Date.now() + 1000 },
        },
      },
    })
    let goal = await readGoal(root)
    assert.equal(goal.status, "active", "ordinary transient provider retry must stay under OpenCode retry policy")
    assert.equal(fake.abortCount, 0)

    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            attempt: 2,
            message: "Usage limit reached",
            action: {
              reason: "account_rate_limit",
              provider: "opencode",
              title: "Go limit reached",
              message: "Usage limit reached. It will reset later.",
              label: "open settings",
            },
            next: Date.now() + 60_000,
          },
        },
      },
    })
    goal = await readGoal(root)
    assert.equal(goal.status, "usage_limited")
    assert.match(goal.stopReason, /provider usage limit/i)
    assert.match(goal.stopReason, /Go limit reached/)
    assert.equal(fake.abortCount, 1, "usage-limited provider retry must be aborted instead of looping")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    assert.equal(fake.prompts.length, 0, "usage_limited goal must not auto-continue on idle")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("fatal provider authentication error pauses the active goal but aborted errors do not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-provider-error-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndOwn(hooks)

    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "MessageAbortedError", data: { message: "aborted" } },
        },
      },
    })
    let goal = await readGoal(root)
    assert.equal(goal.status, "active")
    assert.equal(fake.abortCount, 0)

    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "ProviderAuthError", data: { providerID: "p", message: "invalid API key" } },
        },
      },
    })
    goal = await readGoal(root)
    assert.equal(goal.status, "paused")
    assert.match(goal.stopReason, /authentication failed.*invalid API key/i)
    assert.equal(fake.abortCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("budget-limited goal cannot resume until its budget is raised", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-budget-control-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndOwn(hooks, "ship release --max-turns 1")
    await completeOwnedAssistant(hooks)

    let goal = await readGoal(root)
    assert.equal(goal.status, "active", "mid-prompt usage accounting must keep Goal safety hooks active")
    assert.equal(goal.usage.turns, 1)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    goal = await readGoal(root)
    assert.equal(goal.status, "budget_limited")
    assert.match(goal.stopReason, /turns 1 \/ 1/)
    assert.equal(fake.prompts.length, 0, "reached budget must stop autonomous continuation at idle")

    const blockedResume = { parts: [{ type: "text", text: "resume" }] }
    await hooks["command.execute.before"]({ command: "goal", sessionID: "s1", arguments: "resume" }, blockedResume)
    goal = await readGoal(root)
    assert.equal(goal.status, "budget_limited")
    assert.equal(blockedResume.noReply, true)
    assert.match(blockedResume.parts[0].text, /Budget is still exhausted/)
    assert.match(blockedResume.parts[0].text, /1 \/ 1 turns/)

    const raise = { parts: [{ type: "text", text: "budget" }] }
    await hooks["command.execute.before"]({ command: "goal", sessionID: "s1", arguments: "budget --max-turns 2" }, raise)
    goal = await readGoal(root)
    assert.equal(goal.status, "active")
    assert.equal(goal.budget.maxTurns, 2)
    assert.equal(goal.usage.turns, 1)
    assert.equal(goal.revision, 1, "budget changes must not invalidate goal evidence by changing revision")
    assert.match(raise.parts[0].text, /Continue working toward the active OpenCode goal/)
    assert.match(raise.parts[0].text, /turns=1\/2/)

    await hooks["chat.message"](
      { sessionID: "s1", messageID: "user-budget", agent: "build", model: { providerID: "p", modelID: "m" } },
      { message: { id: "user-budget" }, parts: raise.parts },
    )
    goal = await readGoal(root)
    assert.equal(goal.status, "active", "budget continuation must remain command-owned")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("budget command can clear limits and status shows used versus allowed values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-budget-status-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createAndOwn(hooks, "ship release --max-turns 5 --max-tokens 100")

    const budget = { parts: [{ type: "text", text: "budget" }] }
    await hooks["command.execute.before"]({ command: "goal", sessionID: "s1", arguments: "budget --max-turns 0 --max-tokens 0 --max-minutes 0 --max-cost 0" }, budget)
    let goal = await readGoal(root)
    assert.equal(goal.budget.maxTurns, 0)
    assert.equal(goal.budget.maxTokens, 0)
    assert.equal(goal.budget.maxRuntimeMs, 0)
    assert.equal(goal.budget.maxCost, 0)
    assert.match(budget.parts[0].text, /0 \/ unlimited turns/)
    assert.match(budget.parts[0].text, /0 \/ unlimited tokens/)

    const status = { parts: [{ type: "text", text: "status" }] }
    await hooks["command.execute.before"]({ command: "goal", sessionID: "s1", arguments: "status" }, status)
    assert.match(status.parts[0].text, /Budget:/)
    assert.match(status.parts[0].text, /runtime 0s \/ unlimited/)
    goal = await readGoal(root)
    assert.equal(goal.revision, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
