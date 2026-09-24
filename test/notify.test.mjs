import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal, editGoal } from "../dist/domain/goal.js"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"
import { GoalStore, GoalStoreIntegrityError } from "../dist/persistence/store.js"
import { completeGoal } from "../dist/verification/audit.js"
import {
  completionNotificationReason,
  createGoalTransitionNotifier,
  formatGoalNotifyCommand,
  notifyGoal,
} from "../dist/opencode/notify.js"

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

function fakeChild() {
  return {
    kill() {},
    unref() {},
    on() { return this },
  }
}

test("notify command survives Goal create/edit persistence and rejects corrupt stored values", async () => {
  await withRoot("opencode-goal-notify-state-", async (root) => {
    const sessionID = "notify-state-session"
    const store = new GoalStore(root)
    let goal = createGoal({
      sessionID,
      objective: "ship",
      notifyCommand: "  notifier {reason} {goal}  ",
      now: 100,
    })
    assert.equal(goal.notifyCommand, "notifier {reason} {goal}")
    await store.save(goal)

    const loaded = await store.load(sessionID)
    assert.equal(loaded.notifyCommand, "notifier {reason} {goal}")

    goal = editGoal(loaded, { objective: "ship revised", now: 200 })
    assert.equal(goal.notifyCommand, "notifier {reason} {goal}", "edit without --notify must preserve the existing command")

    goal = editGoal(goal, { objective: "ship v3", notifyCommand: "other {goal}", now: 300 })
    assert.equal(goal.notifyCommand, "other {goal}")

    await store.save(goal)
    const file = store.fileFor(sessionID)
    const valid = JSON.parse(await readFile(file, "utf8"))
    valid.notifyCommand = 42
    await writeFile(file, `${JSON.stringify(valid, null, 2)}\n`, "utf8")
    await assert.rejects(
      () => store.load(sessionID),
      (error) => error instanceof GoalStoreIntegrityError
        && error.kind === "invalid_state"
        && error.message.includes("invalid notifyCommand"),
    )

    valid.notifyCommand = "   "
    await writeFile(file, `${JSON.stringify(valid, null, 2)}\n`, "utf8")
    await assert.rejects(
      () => store.load(sessionID),
      (error) => error instanceof GoalStoreIntegrityError
        && error.kind === "invalid_state"
        && error.message.includes("invalid notifyCommand"),
    )
  })
})

test("durable terminal transitions notify once while no-op and same-status saves stay silent", async () => {
  await withRoot("opencode-goal-notify-transition-", async (root) => {
    const transitions = []
    let store
    store = new GoalStore(root, {
      onTransition(goal, reason) {
        const persisted = JSON.parse(readFileSync(store.fileFor(goal.sessionID), "utf8"))
        transitions.push({ status: goal.status, reason, persistedStatus: persisted.status })
      },
    })

    const sessionID = "notify-transition-session"
    const goal = createGoal({ sessionID, objective: "work", notifyCommand: "tool {reason} {goal}", now: 100 })
    await store.save(goal)
    assert.deepEqual(transitions, [])

    const noOp = await store.load(sessionID)
    noOp.updatedAt += 10
    await store.save(noOp)
    assert.equal(noOp.storageGeneration, 1)
    assert.deepEqual(transitions, [], "semantic no-op saves must not emit notifications")

    let current = await store.load(sessionID)
    current = { ...current, status: "paused", stopReason: "manual pause", updatedAt: 200 }
    await store.save(current)
    assert.deepEqual(transitions.at(-1), { status: "paused", reason: "paused", persistedStatus: "paused" })

    current.stopReason = "same status, changed reason"
    current.updatedAt = 210
    await store.save(current)
    assert.equal(transitions.length, 1, "same-status semantic writes must not duplicate lifecycle notifications")

    current = { ...current, status: "active", stopReason: undefined, updatedAt: 220 }
    await store.save(current)
    assert.equal(transitions.length, 1, "active is not a notification lifecycle state")

    current = { ...current, status: "waiting_user", stopReason: "approval required", updatedAt: 230 }
    await store.save(current)
    assert.deepEqual(transitions.at(-1), { status: "waiting_user", reason: "paused", persistedStatus: "waiting_user" })

    current = { ...current, status: "active", stopReason: undefined, updatedAt: 240 }
    await store.save(current)
    current = { ...current, status: "budget_limited", stopReason: "budget", updatedAt: 250 }
    await store.save(current)
    assert.deepEqual(transitions.at(-1), { status: "budget_limited", reason: "paused", persistedStatus: "budget_limited" })

    current = { ...current, status: "active", stopReason: undefined, updatedAt: 260 }
    await store.save(current)
    current = { ...current, status: "usage_limited", stopReason: "provider", updatedAt: 270 }
    await store.save(current)
    assert.deepEqual(transitions.at(-1), { status: "usage_limited", reason: "paused", persistedStatus: "usage_limited" })

    current = { ...current, status: "active", stopReason: undefined, updatedAt: 280 }
    await store.save(current)
    current = { ...current, status: "blocked", stopReason: "external blocker", updatedAt: 290 }
    await store.save(current)
    assert.deepEqual(transitions.at(-1), { status: "blocked", reason: "blocked", persistedStatus: "blocked" })

    current = { ...current, status: "active", stopReason: undefined, updatedAt: 300 }
    await store.save(current)
    current = { ...current, status: "completed", completionSummary: "done", updatedAt: 310 }
    await store.save(current)
    assert.deepEqual(transitions.at(-1), { status: "completed", reason: "completed", persistedStatus: "completed" })

    assert.deepEqual(transitions.map((item) => item.reason), ["paused", "paused", "paused", "paused", "blocked", "completed"])
  })
})

test("notification callback failures cannot roll back durable Goal persistence", async () => {
  await withRoot("opencode-goal-notify-callback-failure-", async (root) => {
    const sessionID = "notify-callback-failure"
    const store = new GoalStore(root, {
      onTransition() {
        throw new Error("notification sink exploded")
      },
    })
    const goal = createGoal({ sessionID, objective: "stay durable", notifyCommand: "tool {reason}" })
    await store.save(goal)

    const paused = { ...goal, status: "paused", stopReason: "pause anyway", updatedAt: goal.updatedAt + 1 }
    await assert.doesNotReject(() => store.save(paused))
    assert.equal((await store.load(sessionID)).status, "paused")
  })
})

test("restoring an archived notified Goal emits one paused transition after persistence", async () => {
  await withRoot("opencode-goal-notify-restore-", async (root) => {
    const transitions = []
    const store = new GoalStore(root, { onTransition: (goal, reason) => transitions.push([goal.status, reason]) })
    const goal = createGoal({
      sessionID: "notify-restore-session",
      objective: "restore me",
      notifyCommand: "tool {reason} {goal}",
      now: 100,
    })
    await store.save(goal)
    await store.clear(goal.sessionID)
    assert.deepEqual(transitions, [])

    const restored = await store.restore(goal.sessionID, goal.id.slice(0, 12), 200)
    assert.equal(restored.ok, true)
    assert.deepEqual(transitions, [["paused", "paused"]])
  })
})

test("notify runner substitutes only stable lifecycle tokens and is fully advisory", async () => {
  await withRoot("opencode-goal-notify-runner-", async (root) => {
    const calls = []
    const goal = { id: "goal-123", notifyCommand: "notify {reason} {goal} {reason}" }
    notifyGoal(root, goal, "blocked", {
      spawn(command, options) {
        calls.push({ command, options })
        return fakeChild()
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, "notify blocked goal-123 blocked")
    assert.equal(calls[0].options.cwd, root)
    assert.equal(calls[0].options.shell, true)
    assert.equal(calls[0].options.detached, true)
    assert.equal(calls[0].options.stdio, "ignore")
    assert.equal(formatGoalNotifyCommand("x {goal} y {reason}", "g1", "completed"), "x g1 y completed")
    assert.equal(formatGoalNotifyCommand("x {goal} y {reason}", "g1", "progress"), "x g1 y progress")

    assert.doesNotThrow(() => notifyGoal(root, goal, "paused", {
      spawn() { throw new Error("missing command") },
    }))

    let spawned = false
    notifyGoal(root, { id: "goal-no-command" }, "completed", {
      spawn() {
        spawned = true
        return fakeChild()
      },
    })
    assert.equal(spawned, false)
  })
})

test("queued Goals preserve their user-authored notification command through promotion", async () => {
  await withRoot("opencode-goal-notify-queue-", async (root) => {
    const sequences = new GoalSequenceStore(root)
    const result = await sequences.enqueue("notify-queue-session", {
      objective: "queued work",
      notifyCommand: "tool {reason} {goal}",
    })
    assert.equal(result.item.notifyCommand, "tool {reason} {goal}")

    const promoted = await sequences.promoteNext("notify-queue-session")
    assert.equal(promoted.ok, true)
    assert.equal(promoted.goal.notifyCommand, "tool {reason} {goal}")
  })
})

test("failed completion audit has a rejected notification reason while Goal remains active", () => {
  const goal = createGoal({
    sessionID: "notify-rejected-session",
    objective: "ship",
    notifyCommand: "tool {reason} {goal}",
  })
  const result = completeGoal(goal, "done")
  assert.equal(result.audit.ok, false)
  assert.equal(result.goal.status, "active")
  assert.equal(completionNotificationReason(result.goal, result.audit), "rejected")
  assert.equal(completionNotificationReason({ ...result.goal, status: "completed" }, { ok: true }), undefined)
})

test("Goal command owns notify configuration and model-facing Goal tools expose no notify mutation field", async () => {
  await withRoot("opencode-goal-notify-command-owner-", async (root) => {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const output = { parts: [{ type: "text", text: "raw args" }] }
    await hooks["command.execute.before"](
      {
        command: "goal",
        sessionID: "notify-command-session",
        arguments: 'ship it --notify "tool {reason} {goal}"',
      },
      output,
    )

    const goal = await new GoalStore(root).load("notify-command-session")
    assert.equal(goal.notifyCommand, "tool {reason} {goal}")

    for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
      if (!name.startsWith("opencode_goal_")) continue
      assert.equal(
        Object.prototype.hasOwnProperty.call(definition.args ?? {}, "notifyCommand"),
        false,
        `${name} must not expose notifyCommand to the model`,
      )
    }
  })
})

test("transition notifier helper delegates without changing Goal persistence semantics", async () => {
  await withRoot("opencode-goal-notify-helper-", async (root) => {
    const calls = []
    const notifier = createGoalTransitionNotifier(root, {
      spawn(command) {
        calls.push(command)
        return fakeChild()
      },
    })
    const goal = createGoal({
      sessionID: "notify-helper-session",
      objective: "helper",
      notifyCommand: "tool {reason} {goal}",
    })
    notifier(goal, "completed")
    assert.deepEqual(calls, [`tool completed ${goal.id}`])
  })
})
