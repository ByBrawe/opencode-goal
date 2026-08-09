import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeClient(toasts = [], throwToast = false) {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
    tui: {
      async showToast(input) {
        if (throwToast) throw new Error("no TUI attached")
        toasts.push(input.body)
        return true
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

async function bindCommandMessage(hooks, sessionID, messageID, output, agent = "build") {
  await hooks["chat.message"](
    { sessionID, messageID, agent },
    { message: { id: messageID }, parts: output.parts },
  )
}

test("goal contract exposes success criteria and enforced constraints without pausing work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-contract-"))
  try {
    const sessionID = "contract-session"
    const toasts = []
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(toasts), directory: root })

    const createOutput = await runGoalCommand(
      hooks,
      sessionID,
      'ship release --success "tests pass" --constraint "public API stays compatible" --non-goal "do not add a framework" --check "npm test"',
    )
    assert.match(createOutput.parts[0].text, /<goal_constraints>/)
    assert.match(createOutput.parts[0].text, /public API stays compatible/)
    await bindCommandMessage(hooks, sessionID, "create-command", createOutput)

    const goal = await store.load(sessionID)
    assert.equal(goal.status, "active")
    assert.deepEqual(goal.constraints, ["public API stays compatible", "do not add a framework"])
    assert.ok(goal.requirements.some((item) => item.source === "acceptance" && item.text === "tests pass"))
    assert.ok(goal.requirements.some((item) => item.source === "constraint" && /public API stays compatible/.test(item.text)))
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].title, "OpenCode Goals")
    assert.equal(toasts[0].variant, "success")

    const contractOutput = await runGoalCommand(hooks, sessionID, "contract")
    assert.match(contractOutput.parts[0].text, /Goal Contract/)
    assert.match(contractOutput.parts[0].text, /Success criteria:\n- \[pending\] tests pass/)
    assert.match(contractOutput.parts[0].text, /Constraints \/ non-goals:\n- public API stays compatible\n- do not add a framework/)
    assert.match(contractOutput.parts[0].text, /Verification command passes: npm test/)
    await bindCommandMessage(hooks, sessionID, "contract-command", contractOutput)

    const unchanged = await store.load(sessionID)
    assert.equal(unchanged.id, goal.id)
    assert.equal(unchanged.status, "active", "read-only contract command must not pause the Goal")
    assert.equal(unchanged.revision, goal.revision)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("goal edit can replace constraints inside the edited revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-contract-edit-"))
  try {
    const sessionID = "contract-edit-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })

    const createOutput = await runGoalCommand(hooks, sessionID, 'ship v1 --success "tests pass" --constraint "no dependency changes"')
    await bindCommandMessage(hooks, sessionID, "create-command", createOutput)
    const before = await store.load(sessionID)

    const editOutput = await runGoalCommand(hooks, sessionID, 'edit ship v2 --constraint "keep public API stable"')
    assert.match(editOutput.parts[0].text, /keep public API stable/)
    await bindCommandMessage(hooks, sessionID, "edit-command", editOutput)
    const after = await store.load(sessionID)

    assert.equal(after.id, before.id)
    assert.equal(after.revision, before.revision + 1)
    assert.deepEqual(after.constraints, ["keep public API stable"])
    assert.ok(after.requirements.some((item) => item.source === "acceptance" && item.text === "tests pass"), "success criteria survive edit when not replaced")
    assert.equal(after.requirements.filter((item) => item.source === "constraint").length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("TUI toast failures never affect Goal persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-toast-"))
  try {
    const sessionID = "toast-session"
    const store = new GoalStore(root)
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient([], true), directory: root })
    const output = await runGoalCommand(hooks, sessionID, "ship safely")
    await bindCommandMessage(hooks, sessionID, "create-command", output)
    assert.equal((await store.load(sessionID)).status, "active")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
