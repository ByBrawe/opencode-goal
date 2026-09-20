import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import { GoalStore } from "../dist/persistence/store.js"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"
import { completeGoal } from "../dist/verification/audit.js"
import {
  completionNotificationReason,
  createGoalTransitionNotifier,
  formatGoalNotifyCommand,
  notifyGoal,
} from "../dist/opencode/notify.js"

function fakeChild() {
  return { kill() {}, unref() {}, on() {} }
}

async function withRoot(prefix, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
    tui: {
      showToast() { return Promise.resolve(true) },
    },
  }
}

test("the /goal command threads the notify flag into persisted Goal state", async () => {
  await withRoot("opencode-goal-notify-command-", async (root) => {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const output = { parts: [{ type: "text", text: "raw args" }] }
    await hooks["command.execute.before"](
      { command: "goal", sessionID: "command-session", arguments: 'ship it --check "npm test" --notify "tool {reason} {goal}"' },
      output,
    )
    const goal = await new GoalStore(root).load("command-session")
    assert.equal(goal.notifyCommand, "tool {reason} {goal}")
    assert.deepEqual(goal.checks, ["npm test"])
  })
})

test("notify command round-trips through Goal creation and project storage", async () => {
  await withRoot("opencode-goal-notify-roundtrip-", async (root) => {
    const store = new GoalStore(root)
    const goal = createGoal({
      sessionID: "notify-session",
      objective: "ship",
      checks: ["npm test"],
      notifyCommand: "mytool {reason} {goal}",
    })
    assert.equal(goal.notifyCommand, "mytool {reason} {goal}")
    await store.save(goal)
    const loaded = await store.load("notify-session")
    assert.deepEqual(loaded, goal)

    const preserved = editGoal(loaded, { objective: "ship v2" })
    assert.equal(preserved.notifyCommand, "mytool {reason} {goal}")
    const replaced = editGoal(loaded, { objective: "ship v3", notifyCommand: "other {goal}" })
    assert.equal(replaced.notifyCommand, "other {goal}")
  })
})

test("stored Goal state without a notify command round-trips unchanged", async () => {
  await withRoot("opencode-goal-notify-legacy-", async (root) => {
    const sessionID = "legacy-session"
    const store = new GoalStore(root)
    const legacy = createGoal({ sessionID, objective: "legacy", now: 10 })
    assert.equal(legacy.notifyCommand, undefined)
    await store.save(legacy)
    assert.doesNotMatch(await readFile(store.fileFor(sessionID), "utf8"), /notifyCommand/)

    const loaded = await store.load(sessionID)
    assert.equal(loaded.notifyCommand, undefined)
    await store.save(loaded)
    assert.doesNotMatch(await readFile(store.fileFor(sessionID), "utf8"), /notifyCommand/)
  })
})

test("transition callback fires exactly once per real persisted status change", async () => {
  await withRoot("opencode-goal-notify-transitions-", async (root) => {
    const transitions = []
    const store = new GoalStore(root, { onTransition: (goal, reason) => transitions.push([goal.status, reason]) })
    await store.save(createGoal({ sessionID: "session-a", objective: "work" }))
    assert.deepEqual(transitions, [])

    for (const status of ["paused", "paused", "blocked", "completed", "paused"]) {
      const current = await store.load("session-a")
      await store.save({ ...current, status })
    }

    assert.deepEqual(transitions, [
      ["paused", "paused"],
      ["blocked", "blocked"],
      ["completed", "completed"],
      ["paused", "paused"],
    ])
  })
})

test("restoring an archived Goal as paused announces the persisted transition", async () => {
  await withRoot("opencode-goal-notify-restore-", async (root) => {
    const transitions = []
    const store = new GoalStore(root, { onTransition: (goal, reason) => transitions.push([goal.status, reason]) })
    const first = createGoal({ sessionID: "session-a", objective: "first", now: 100 })
    await store.save(first)
    await store.clear("session-a")
    assert.deepEqual(transitions, [])

    const result = await store.restore("session-a", first.id.slice(0, 12), 200)
    assert.equal(result.ok, true)
    assert.deepEqual(transitions, [["paused", "paused"]])
  })
})

test("budget and usage limits notify as paused", async () => {
  await withRoot("opencode-goal-notify-limits-", async (root) => {
    const transitions = []
    const store = new GoalStore(root, { onTransition: (_goal, reason) => transitions.push(reason) })
    await store.save(createGoal({ sessionID: "session-a", objective: "work" }))
    for (const status of ["budget_limited", "active", "usage_limited"]) {
      const current = await store.load("session-a")
      await store.save({ ...current, status })
    }
    assert.deepEqual(transitions, ["paused", "paused"])
  })
})

test("transition notifier runs Loop-compatible substitutions fire-and-forget", async () => {
  await withRoot("opencode-goal-notify-spawn-", async (root) => {
    const calls = []
    const child = fakeChild()
    const store = new GoalStore(root, {
      onTransition: createGoalTransitionNotifier(root, {
        spawn: (command, options) => {
          calls.push({ command, options })
          return child
        },
      }),
    })
    const goal = createGoal({
      sessionID: "session-a",
      objective: "work",
      notifyCommand: "mytool {reason} {goal} {reason}",
    })
    await store.save(goal)
    const current = await store.load("session-a")
    await store.save({ ...current, status: "blocked" })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, `mytool blocked ${goal.id} blocked`)
    assert.equal(calls[0].options.cwd, root)
    assert.equal(calls[0].options.shell, true)
    assert.equal(calls[0].options.detached, true)
    assert.equal(calls[0].options.stdio, "ignore")
    assert.equal(formatGoalNotifyCommand("x {goal} y {reason}", "g1", "completed"), "x g1 y completed")
  })
})

test("a failing or missing notify command cannot throw out of save or execute", async () => {
  await withRoot("opencode-goal-notify-failure-", async (root) => {
    const store = new GoalStore(root, {
      onTransition: createGoalTransitionNotifier(root, { spawn: () => { throw new Error("spawn failed") } }),
    })
    const goal = createGoal({ sessionID: "session-a", objective: "work", notifyCommand: "mytool {reason}" })
    await store.save(goal)
    const current = await store.load("session-a")
    await assert.doesNotReject(() => store.save({ ...current, status: "paused" }))
    assert.equal((await store.load("session-a")).status, "paused")

    assert.doesNotThrow(() => notifyGoal(root, { id: "g1", notifyCommand: "boom {goal}" }, "paused", {
      spawn: () => { throw new Error("boom") },
    }))
    assert.doesNotThrow(() => notifyGoal(root, { id: "g2" }, "completed"))
    assert.doesNotThrow(() => notifyGoal(root, { id: "g3", notifyCommand: "hanging {goal}" }, "paused", {
      spawn: () => ({ kill() { throw new Error("kill failed") }, unref() { throw new Error("unref failed") }, on() { throw new Error("on failed") } }),
    }))

    let spawned = false
    notifyGoal(root, { id: "g4" }, "completed", { spawn: () => { spawned = true; return fakeChild() } })
    assert.equal(spawned, false)
  })
})

test("a completion attempt that fails the audit classifies as rejected while the Goal stays active", () => {
  const goal = createGoal({ sessionID: "session-a", objective: "ship", notifyCommand: "tool {reason} {goal}" })
  const result = completeGoal(goal, "done")
  assert.equal(result.audit.ok, false)
  assert.equal(result.goal.status, "active")
  assert.equal(completionNotificationReason(result.goal, result.audit), "rejected")
  assert.equal(completionNotificationReason({ ...result.goal, status: "completed" }, { ok: true }), undefined)
})

test("queued Goals preserve the notify command through promotion", async () => {
  await withRoot("opencode-goal-notify-queue-", async (root) => {
    const goals = new GoalStore(root)
    const sequences = new GoalSequenceStore(root)
    const enqueued = await sequences.enqueue("queue-session", {
      objective: "queued work",
      notifyCommand: "tool {reason} {goal}",
    })
    assert.equal(enqueued.item.notifyCommand, "tool {reason} {goal}")

    const promoted = await sequences.promoteNext("queue-session")
    assert.equal(promoted.ok, true)
    assert.equal(promoted.goal.notifyCommand, "tool {reason} {goal}")
    assert.equal((await goals.load("queue-session")).notifyCommand, "tool {reason} {goal}")
  })
})
