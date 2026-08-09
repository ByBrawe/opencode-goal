import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeClient() {
  let promptCount = 0
  const toasts = []
  return {
    client: {
      session: {
        prompt() {
          promptCount += 1
          return Promise.resolve({})
        },
        abort() {
          return Promise.resolve(true)
        },
      },
      tui: {
        showToast(input) {
          toasts.push(input)
          return Promise.resolve({})
        },
      },
    },
    get promptCount() { return promptCount },
    toasts,
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function runGoalCommand(hooks, sessionID, argumentsText) {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: argumentsText },
    output,
  )
  return output
}

async function bindGoalCommand(hooks, sessionID, messageID, output, agent = "build") {
  await hooks["chat.message"](
    { sessionID, messageID, agent, model: { providerID: "p", modelID: "m" }, variant: "high" },
    { message: { id: messageID }, parts: output.parts },
  )
}

test("Goal draft persists the full contract paused and cannot auto-start through command idle or restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-draft-"))
  try {
    const sessionID = "draft-session"
    const host = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: host.client, directory: root })
    const store = new GoalStore(root)

    const output = await runGoalCommand(
      hooks,
      sessionID,
      'draft ship safely --success "tests pass" --constraint "keep API compatible" --check "npm test" --contains "README.md::OpenCode Goals" --max-turns 12 --max-cost 3.5',
    )

    assert.equal(host.promptCount, 0)
    assert.match(output.parts[0].text, /Goal Contract/)
    assert.match(output.parts[0].text, /Status: paused/)
    assert.match(output.parts[0].text, /Draft saved paused/)

    let goal = await store.load(sessionID)
    assert.ok(goal)
    assert.equal(goal.status, "paused")
    assert.match(goal.stopReason, /Goal draft saved/)
    assert.equal(goal.objective, "ship safely")
    assert.deepEqual(goal.constraints, ["keep API compatible"])
    assert.equal(goal.budget.maxTurns, 12)
    assert.equal(goal.budget.maxCost, 3.5)
    assert.ok(goal.requirements.some((item) => item.source === "acceptance" && item.text === "tests pass"))
    assert.ok(goal.requirements.some((item) => item.source === "constraint" && /keep API compatible/.test(item.text)))
    assert.ok(goal.requirements.some((item) => item.source === "check" && item.command === "npm test"))
    assert.ok(goal.requirements.some((item) => item.source === "file" && item.file === "README.md" && item.contains === "OpenCode Goals"))

    await bindGoalCommand(hooks, sessionID, "draft-command", output, "build")
    goal = await store.load(sessionID)
    assert.equal(goal.status, "paused")
    assert.match(goal.stopReason, /Goal draft saved/)
    assert.equal(goal.execution?.agent, "build")
    assert.equal(host.promptCount, 0)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    assert.equal(host.promptCount, 0, "paused draft must never dispatch an idle continuation")

    const restartedHost = fakeClient()
    await OpenCodeGoalPlugin({ client: restartedHost.client, directory: root })
    await tick()
    assert.equal(restartedHost.promptCount, 0, "paused draft must never enter startup recovery")

    const resume = await runGoalCommand(hooks, sessionID, "resume")
    assert.match(resume.parts[0].text, /Continue working toward the active OpenCode goal/)
    goal = await store.load(sessionID)
    assert.equal(goal.status, "active", "only explicit resume activates the draft")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Goal draft cannot replace an unfinished live Goal and remains paused in Plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-draft-safety-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient().client, directory: root })
    const store = new GoalStore(root)

    const existingSession = "draft-existing-session"
    const existingOutput = await runGoalCommand(hooks, existingSession, "ship existing work")
    await bindGoalCommand(hooks, existingSession, "existing-create", existingOutput, "build")
    const before = await store.load(existingSession)
    assert.equal(before.status, "active")

    await assert.rejects(
      runGoalCommand(hooks, existingSession, "draft replace existing work"),
      /unfinished goal already exists/i,
    )
    assert.deepEqual(await store.load(existingSession), before)

    const planSession = "draft-plan-session"
    const draft = await runGoalCommand(hooks, planSession, 'draft plan reviewed work --constraint "do not edit yet"')
    await bindGoalCommand(hooks, planSession, "plan-draft", draft, "Plan")
    const planned = await store.load(planSession)
    assert.equal(planned.status, "paused")
    assert.match(planned.stopReason, /Goal draft saved/)
    assert.equal(planned.execution?.agent, "Plan")
    assert.deepEqual(planned.constraints, ["do not edit yet"])

    const refused = await runGoalCommand(hooks, planSession, "resume")
    await bindGoalCommand(hooks, planSession, "plan-resume", refused, "Plan")
    const afterResume = await store.load(planSession)
    assert.equal(afterResume.status, "paused")
    assert.match(afterResume.stopReason, /restricted agent/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
