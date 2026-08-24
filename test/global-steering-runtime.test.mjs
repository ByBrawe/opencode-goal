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
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
    tui: {
      showToast() { return Promise.resolve({}) },
    },
  }
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

test("auto-stall re-entry is language agnostic and preserves original foreground text", async () => {
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
      const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
      const store = new GoalStore(root)
      await createGoalCommand(hooks, "finish the repository work")
      const active = await store.load("global-steering")
      assert.ok(active)
      await store.save(pauseGoal(active, AUTO_STALL_REASON))

      const output = await foregroundChat(hooks, text, `human-${index}`)
      const persisted = await readOnlyGoal(root)
      assert.equal(persisted.status, "active", `foreground message ${index + 1} should re-enter the auto-stalled Goal`)
      assert.equal(persisted.stalledTurns, 0)
      assert.equal(output.parts[0].text, text, "the model must receive the user's original language and wording unchanged")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("foreign slash-command traffic cannot wake an auto-stalled Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-global-foreign-command-"))
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
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
