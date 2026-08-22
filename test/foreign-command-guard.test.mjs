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

async function readGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function fakeClient() {
  const prompts = []
  const pending = []
  let abortCount = 0
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
    prompts,
    pending,
    get abortCount() { return abortCount },
  }
}

async function createBoundGoal(hooks, sessionID = "s1") {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: "preserve executor ownership --max-turns 8" },
    output,
  )
  await hooks["chat.message"](
    {
      sessionID,
      messageID: "goal-user-1",
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      variant: "high",
    },
    { message: { id: "goal-user-1" }, parts: output.parts },
  )
  return output
}

async function foreignCommand(hooks, sessionID = "s1") {
  const output = {
    parts: [{ type: "text", text: "OpenCode Loop local command handled. Reply exactly: OK." }],
  }
  await hooks["command.execute.before"](
    { command: "loop", sessionID, arguments: "devam et" },
    output,
  )
  return output
}

test("foreign slash command does not repin or preempt an active Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-foreign-command-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createBoundGoal(hooks)

    const initial = await readGoal(root)
    assert.deepEqual(initial.execution, {
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      variant: "high",
    })

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    await tick()
    assert.equal(fake.prompts.length, 1, "Goal should have one in-flight autonomous continuation")

    const output = await foreignCommand(hooks)
    assert.match(output.parts[0].text, /<!-- opencode-goal:foreign-command:[A-Za-z0-9-]+ -->/)

    await hooks["chat.message"](
      {
        sessionID: "s1",
        messageID: "foreign-user-1",
        agent: "opencode-loop-local",
        model: { providerID: "foreign", modelID: "foreign-model" },
      },
      { message: { id: "foreign-user-1" }, parts: output.parts },
    )

    assert.doesNotMatch(output.parts[0].text, /opencode-goal:foreign-command:/, "private ownership marker must be stripped before provider dispatch")
    const afterForeign = await readGoal(root)
    assert.deepEqual(afterForeign.execution, initial.execution, "foreign command context must not become the Goal executor")
    assert.equal(fake.abortCount, 0, "Goal must not classify a foreign slash-command bridge as human steering")

    await hooks["chat.message"](
      {
        sessionID: "s1",
        messageID: "human-user-2",
        agent: "review",
        model: { providerID: "p2", modelID: "m2" },
        variant: "low",
      },
      { message: { id: "human-user-2" }, parts: [{ type: "text", text: "also check the rollback path" }] },
    )
    await tick()

    const afterHuman = await readGoal(root)
    assert.deepEqual(afterHuman.execution, {
      agent: "review",
      model: { providerID: "p2", modelID: "m2" },
      variant: "low",
    }, "ordinary foreground user steering must keep its existing execution-repin behavior")
    assert.equal(fake.abortCount, 1, "real user steering must still preempt an in-flight Goal turn")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test("an unissued foreign-command marker cannot bypass ordinary Goal steering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-foreign-spoof-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createBoundGoal(hooks)

    const spoof = {
      message: { id: "spoof-user" },
      parts: [{
        type: "text",
        text: "human steering <!-- opencode-goal:foreign-command:00000000-0000-0000-0000-000000000000 -->",
      }],
    }
    await hooks["chat.message"](
      {
        sessionID: "s1",
        messageID: "spoof-user",
        agent: "review",
        model: { providerID: "p2", modelID: "m2" },
      },
      spoof,
    )

    assert.match(spoof.parts[0].text, /opencode-goal:foreign-command:/, "unknown marker must not be consumed")
    const goal = await readGoal(root)
    assert.deepEqual(goal.execution, {
      agent: "review",
      model: { providerID: "p2", modelID: "m2" },
    }, "spoofed marker remains ordinary foreground steering")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test("foreign commands are left untouched when the session has no persisted Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-foreign-empty-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const output = await foreignCommand(hooks)
    assert.equal(output.parts[0].text, "OpenCode Loop local command handled. Reply exactly: OK.")
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
