import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeClient() {
  const prompts = []
  const toasts = []
  return {
    prompts,
    toasts,
    client: {
      session: {
        prompt(input) { prompts.push(input); return Promise.resolve({}) },
        abort() { return Promise.resolve(true) },
        list() { return Promise.resolve({ data: [] }) },
        status() { return Promise.resolve({ data: {} }) },
      },
      tui: {
        showToast(input) { toasts.push(input.body); return Promise.resolve(true) },
      },
    },
  }
}

async function runGoalCommand(hooks, sessionID, argumentsText) {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: argumentsText },
    output,
  )
  return output
}

async function bindCommandMessage(hooks, sessionID, messageID, output, agent) {
  await hooks["chat.message"](
    { sessionID, messageID, agent },
    { message: { id: messageID }, parts: output.parts },
  )
}

test("goal created from Plan is persisted paused instead of executing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-plan-create-"))
  try {
    const sessionID = "plan-create-session"
    const runtime = fakeClient()
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: runtime.client, directory: root })

    const output = await runGoalCommand(hooks, sessionID, 'ship safely --success "tests pass" --constraint "do not change the public API"')
    assert.match(output.parts[0].text, /Continue working toward the active OpenCode goal/)
    const durablePart = output.parts[0]
    Object.assign(durablePart, {
      id: "part-plan-create",
      sessionID,
      messageID: "plan-create-command",
    })
    await bindCommandMessage(hooks, sessionID, "plan-create-command", output, "plan")

    const goal = await store.load(sessionID)
    assert.equal(goal.status, "paused")
    assert.equal(goal.execution.agent, "plan")
    assert.match(goal.stopReason, /restricted agent "plan"/)
    assert.equal(output.parts.length, 1)
    assert.strictEqual(output.parts[0], durablePart, "Plan safety must rewrite the existing host-owned durable part instead of fabricating a new one")
    assert.equal(output.parts[0].id, "part-plan-create")
    assert.equal(output.parts[0].sessionID, sessionID)
    assert.equal(output.parts[0].messageID, "plan-create-command")
    assert.match(output.parts[0].text, /Goal saved but paused in plan mode/)
    assert.match(output.parts[0].text, /continue analysis\/planning only/i)
    assert.equal(runtime.prompts.length, 0)
    assert.equal(runtime.toasts.at(-1).variant, "warning")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Plan cannot resume a Goal but Build can explicitly resume and repin execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-plan-resume-"))
  try {
    const sessionID = "plan-resume-session"
    const runtime = fakeClient()
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: runtime.client, directory: root })

    const createOutput = await runGoalCommand(hooks, sessionID, "implement feature")
    await bindCommandMessage(hooks, sessionID, "plan-create", createOutput, "PLAN")
    assert.equal((await store.load(sessionID)).status, "paused")

    const planResume = await runGoalCommand(hooks, sessionID, "resume")
    await bindCommandMessage(hooks, sessionID, "plan-resume", planResume, "plan")
    const stillPaused = await store.load(sessionID)
    assert.equal(stillPaused.status, "paused")
    assert.equal(stillPaused.execution.agent, "plan")
    assert.match(planResume.parts[0].text, /switch to Build and run \/goal resume/i)

    const buildResume = await runGoalCommand(hooks, sessionID, "resume")
    await bindCommandMessage(hooks, sessionID, "build-resume", buildResume, "build")
    const active = await store.load(sessionID)
    assert.equal(active.status, "active")
    assert.equal(active.execution.agent, "build")
    assert.match(buildResume.parts[0].text, /Continue working toward the active OpenCode goal/)
    assert.equal(runtime.toasts.at(-1).variant, "success")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("idle cannot auto-continue an active Goal bound to Plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-plan-idle-"))
  try {
    const sessionID = "plan-idle-session"
    const runtime = fakeClient()
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: runtime.client, directory: root })

    const goal = createGoal({ sessionID, objective: "legacy active plan Goal", execution: { agent: "plan" } })
    await store.save(goal)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

    const paused = await store.load(sessionID)
    assert.equal(paused.status, "paused")
    assert.equal(paused.execution.agent, "plan")
    assert.match(paused.stopReason, /switch to Build and run \/goal resume/i)
    assert.equal(runtime.prompts.length, 0, "restricted idle must never dispatch a continuation prompt")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("startup recovery pauses an active persisted Plan Goal before any prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-plan-restart-"))
  try {
    const sessionID = "plan-restart-session"
    const runtime = fakeClient()
    const store = new GoalStore(root)
    const goal = createGoal({ sessionID, objective: "persisted plan Goal", execution: { agent: "plan" } })
    await store.save(goal)

    const hooks = await OpenCodeGoalPlugin({ client: runtime.client, directory: root })
    const paused = await store.load(sessionID)
    assert.equal(paused.status, "paused")
    assert.equal(paused.execution.agent, "plan")
    assert.match(paused.stopReason, /restricted agent "plan"/)

    await hooks.config?.({})
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(runtime.prompts.length, 0, "restart bootstrap must not recover into Plan execution")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})