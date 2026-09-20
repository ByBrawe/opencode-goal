import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeClient() {
  const prompts = []
  return {
    client: {
      session: {
        prompt(arg) {
          prompts.push(arg)
          return Promise.resolve({})
        },
        abort() { return Promise.resolve(true) },
      },
    },
    prompts,
  }
}

async function tick(count = 4) {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

test("waiting-user state sleeps autonomous continuation and resumes at the next idle boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-waiting-user-"))
  const sessionID = "waiting-user"
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)

    const output = { parts: [{ type: "text", text: "raw" }] }
    await hooks["command.execute.before"]({
      command: "goal",
      sessionID,
      arguments: "finish staging and production verification",
    }, output)

    const result = await hooks.tool.opencode_goal_wait_for_user.execute({
      reason: "Production deploy is owned by the user",
      needed: "Deploy the current main revision and confirm completion",
    }, { sessionID })
    assert.match(String(result), /waiting for user input/i)

    let goal = await store.load(sessionID)
    assert.equal(goal.status, "waiting_user")
    assert.match(goal.stopReason, /Production deploy is owned by the user/)
    assert.match(goal.stopReason, /Deploy the current main revision/)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await tick()
    assert.equal(fake.prompts.length, 0, "waiting-user Goal must not autonomously spend another model turn")

    const system = { system: ["base system"] }
    await hooks["experimental.chat.system.transform"]({ sessionID }, system)
    assert.match(system.system[0], /waiting for user input/i)
    assert.match(system.system[0], /opencode_goal_resume/)

    const resumed = await hooks.tool.opencode_goal_resume.execute({}, {
      sessionID,
      messageID: "assistant-routing",
      agent: "build",
    })
    assert.match(String(resumed), /resume accepted/i)

    goal = await store.load(sessionID)
    assert.equal(goal.status, "waiting_user", "routing turn must not activate work mid-turn")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await tick()

    goal = await store.load(sessionID)
    assert.equal(goal.status, "active")
    assert.equal(fake.prompts.length, 1, "resume boundary should dispatch exactly one Goal-owned continuation")
    assert.match(fake.prompts[0].body.parts[0].text, /Continue working toward the active OpenCode goal/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
