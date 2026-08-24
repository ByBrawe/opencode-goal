import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, { createGoal, pauseGoal } from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"
import { accountAssistantUsage } from "../dist/runtime/accounting.js"
import { closeObservedTurn } from "../dist/runtime/progress.js"

const AUTO_STALL_REASON = "Paused after 3 continuation turns without host-observed progress."

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
      tui: {
        showToast() { return Promise.resolve({}) },
      },
    },
    prompts,
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function readOnlyGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

async function createGoalCommand(hooks, objective, sessionID = "global-steering") {
  const output = { parts: [{ type: "text", text: objective }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: objective }, output)
  return output
}

async function foregroundChat(hooks, text, messageID, sessionID = "global-steering") {
  const output = { message: { id: messageID }, parts: [{ type: "text", text }] }
  await hooks["chat.message"]({ sessionID, messageID, agent: "build" }, output)
  return output
}

test("paused foreground messages remain unchanged and are not classified by lifecycle language rules", async () => {
  const messages = [
    "şunu çöz ve testleri bitir",
    "¿puedes corregir esto y terminar las pruebas?",
    "これを修正してテストを終わらせて",
    "أصلح هذا وأكمل الاختبارات",
    "corrige ceci puis termine les tests",
    "napraw to i dokończ testy",
    "что здесь произошло?",
  ]

  for (const [index, text] of messages.entries()) {
    const root = await mkdtemp(path.join(os.tmpdir(), `opencode-goal-global-steering-${index}-`))
    try {
      const fake = fakeClient()
      const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
      const store = new GoalStore(root)
      await createGoalCommand(hooks, "finish the repository work")
      const active = await store.load("global-steering")
      assert.ok(active)
      await store.save(pauseGoal(active, AUTO_STALL_REASON))

      const output = await foregroundChat(hooks, text, `human-${index}`)
      const persisted = await readOnlyGoal(root)
      assert.equal(persisted.status, "paused", `foreground message ${index + 1} must not directly mutate paused Goal state`)
      assert.equal(output.parts[0].text, text, "the model must receive the user's original language and wording unchanged")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("paused Goal context tells the model to decide semantically whether to use the resume tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-model-resume-context-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    await createGoalCommand(hooks, "finish the repository work")
    const active = await store.load("global-steering")
    assert.ok(active)
    await store.save(pauseGoal(active, AUTO_STALL_REASON))

    const output = { system: ["base system"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "global-steering", model: {} }, output)
    assert.match(output.system[0], /persisted Goal is currently paused/)
    assert.match(output.system[0], /opencode_goal_resume/)
    assert.match(output.system[0], /whatever language/)
    assert.match(output.system[0], /status\/explanation/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("model-selected resume tool activates the Goal and idle dispatch restores owned continuation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-model-resume-tool-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    await createGoalCommand(hooks, "finish the repository work")
    const active = await store.load("global-steering")
    assert.ok(active)
    await store.save(pauseGoal(active, AUTO_STALL_REASON))

    const original = await foregroundChat(hooks, "继续，把测试做完", "human-zh")
    assert.equal(original.parts[0].text, "继续，把测试做完")
    let persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused", "model must choose the control tool; chat ingress alone cannot resume")

    const result = await hooks.tool.opencode_goal_resume.execute({}, {
      sessionID: "global-steering",
      messageID: "assistant-routing",
      agent: "build",
    })
    assert.match(String(result), /Goal resumed from the user's natural-language intent/)
    assert.match(String(result), /session idle/)

    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.stalledTurns, 0)
    assert.equal(persisted.skipNextStallCheck, true)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "global-steering" } } })
    await tick()
    persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.skipNextStallCheck, undefined)
    assert.equal(fake.prompts.length, 1, "idle must dispatch the normal Goal-owned continuation after model-selected resume")
    assert.match(fake.prompts[0].body.parts[0].text, /Continue working toward the active OpenCode goal/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("resume tool refuses non-paused Goal states instead of overriding hard controls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-model-resume-guard-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    await createGoalCommand(hooks, "finish the repository work")

    const activeResult = await hooks.tool.opencode_goal_resume.execute({}, {
      sessionID: "global-steering",
      messageID: "assistant-active",
      agent: "build",
    })
    assert.match(String(activeResult), /already active/)

    const store = new GoalStore(root)
    const active = await store.load("global-steering")
    assert.ok(active)
    await store.save({ ...active, status: "usage_limited", stopReason: "provider limit" })
    const limitedResult = await hooks.tool.opencode_goal_resume.execute({}, {
      sessionID: "global-steering",
      messageID: "assistant-limited",
      agent: "build",
    })
    assert.match(String(limitedResult), /status is usage_limited/)
    const persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "usage_limited")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("foreign slash-command traffic cannot wake an auto-stalled Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-global-foreign-command-"))
  try {
    const fake = fakeClient()
    const hooks = await OpenCodeGoalPlugin({ client: fake.client, directory: root })
    const store = new GoalStore(root)
    await createGoalCommand(hooks, "finish the repository work")
    const active = await store.load("global-steering")
    assert.ok(active)
    await store.save(pauseGoal(active, AUTO_STALL_REASON))

    const foreign = { parts: [{ type: "text", text: "OpenCode Loop local command handled." }] }
    await hooks["command.execute.before"]({ command: "loop", sessionID: "global-steering", arguments: "devam et" }, foreign)
    assert.match(foreign.parts[0].text, /opencode-goal:foreign-command:/)

    await hooks["chat.message"](
      { sessionID: "global-steering", messageID: "foreign-command", agent: "opencode-loop-local" },
      { message: { id: "foreign-command" }, parts: foreign.parts },
    )

    const persisted = await readOnlyGoal(root)
    assert.equal(persisted.status, "paused")
    assert.equal(persisted.stopReason, AUTO_STALL_REASON)
    assert.doesNotMatch(foreign.parts[0].text, /opencode-goal:foreign-command:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("new Goals have no implicit runtime cap while explicit runtime caps remain hard guards", () => {
  let unlimited = createGoal({ sessionID: "runtime-unlimited", objective: "long-running work" })
  assert.equal(unlimited.budget.maxRuntimeMs, 0)
  unlimited = accountAssistantUsage(unlimited, { messageID: "u-1", createdAt: 0, completedAt: 2 * 60 * 60_000 })
  unlimited = closeObservedTurn(unlimited, { maxStalledTurns: 100 })
  assert.equal(unlimited.status, "active")
  assert.equal(unlimited.usage.runtimeMs, 2 * 60 * 60_000)

  let bounded = createGoal({
    sessionID: "runtime-bounded",
    objective: "bounded work",
    budget: { maxRuntimeMs: 1_000 },
  })
  bounded = accountAssistantUsage(bounded, { messageID: "b-1", createdAt: 0, completedAt: 1_000 })
  bounded = closeObservedTurn(bounded, { maxStalledTurns: 100 })
  assert.equal(bounded.status, "budget_limited")
  assert.match(bounded.stopReason ?? "", /runtime/)
})
