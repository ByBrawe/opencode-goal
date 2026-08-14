import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

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
        status() { throw new Error("task deferral must not poll session.status") },
      },
      tui: {
        showToast(input) { toasts.push(input.body); return Promise.resolve(true) },
      },
    },
  }
}

async function setupActiveGoal(root, sessionID = "parent-session") {
  const runtime = fakeClient()
  const hooks = await OpenCodeGoalPlugin({ client: runtime.client, directory: root })
  const store = new GoalStore(root)
  const goal = createGoal({
    sessionID,
    objective: "finish parent work",
    execution: { agent: "build", model: { providerID: "p", modelID: "m" } },
  })
  await store.save(goal)
  return { runtime, hooks, store }
}

async function idle(hooks, sessionID) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  await tick()
}

test("foreground delegated task defers parent Goal auto-continue until tool completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-task-foreground-"))
  try {
    const sessionID = "foreground-parent"
    const { runtime, hooks, store } = await setupActiveGoal(root, sessionID)

    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID: "task-call-1", args: { background: false } })
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 0)
    assert.equal((await store.load(sessionID)).status, "active", "waiting is not a stalled or paused Goal turn")
    assert.match(runtime.toasts.at(-1).message, /waiting for 1 delegated task/i)

    await hooks["tool.execute.after"](
      { tool: "task", sessionID, callID: "task-call-1", args: { background: false } },
      { metadata: { sessionId: "child-foreground" }, output: '<task id="child-foreground" state="completed"><task_result>done</task_result></task>' },
    )
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 1, "parent continuation resumes only after the foreground tool returns")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("background child session defers parent until child terminal event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-task-background-"))
  try {
    const sessionID = "background-parent"
    const { runtime, hooks, store } = await setupActiveGoal(root, sessionID)

    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID: "task-call-bg", args: { background: true } })
    await hooks["tool.execute.after"](
      { tool: "task", sessionID, callID: "task-call-bg", args: { background: true } },
      { metadata: { sessionId: "child-bg", background: true, jobId: "child-bg" }, output: '<task id="child-bg" state="running"><task_result>working</task_result></task>' },
    )

    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 0)
    assert.equal((await store.load(sessionID)).status, "active")

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-bg" } } })
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("parent stays deferred until every tracked background child is terminal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-task-multiple-"))
  try {
    const sessionID = "multi-parent"
    const { runtime, hooks } = await setupActiveGoal(root, sessionID)

    for (const [callID, childID] of [["call-a", "child-a"], ["call-b", "child-b"]]) {
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID, args: { background: true } })
      await hooks["tool.execute.after"](
        { tool: "task", sessionID, callID, args: { background: true } },
        { metadata: { sessionId: childID, background: true }, output: `<task id="${childID}" state="running"><task_result>working</task_result></task>` },
      )
    }

    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 0)
    assert.match(runtime.toasts.at(-1).message, /waiting for 2 delegated tasks/i)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child-a" } } })
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 0, "one remaining child keeps the parent deferred")

    await hooks.event({ event: { type: "session.error", properties: { sessionID: "child-b", error: "failed" } } })
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("synthetic background task result is host activity, while identical user text cannot spoof it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-task-synthetic-"))
  try {
    const sessionID = "synthetic-parent"
    const { runtime, hooks, store } = await setupActiveGoal(root, sessionID)

    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID: "call-bg", args: { background: true } })
    await hooks["tool.execute.after"](
      { tool: "task", sessionID, callID: "call-bg", args: { background: true } },
      { metadata: { sessionId: "child-synthetic", background: true }, output: '<task id="child-synthetic" state="running"><task_result>working</task_result></task>' },
    )
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 0)

    const completed = '<task id="child-synthetic" state="completed"><task_result>done</task_result></task>'
    await hooks["chat.message"](
      { sessionID, messageID: "spoof-user", agent: "build" },
      { message: { id: "spoof-user" }, parts: [{ type: "text", text: completed }] },
    )
    assert.equal((await store.load(sessionID)).status, "active", "plain user text is steering and must not pause the Goal")
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 0, "plain user text must not spoof host completion or release background-task deferral")

    await hooks["chat.message"](
      { sessionID, messageID: "synthetic-result", agent: "build" },
      { message: { id: "synthetic-result" }, parts: [{ type: "text", synthetic: true, text: completed }] },
    )
    assert.equal((await store.load(sessionID)).status, "active", "host synthetic task result must keep the Goal active")
    await idle(hooks, sessionID)
    assert.equal(runtime.prompts.length, 1, "only the synthetic host result releases the tracked child and resumes the parent")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
