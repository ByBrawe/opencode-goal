import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal } from "../dist/domain/goal.js"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"
import { GoalStore } from "../dist/persistence/store.js"
import { closeObservedTurn } from "../dist/runtime/progress.js"
import { parseGoalCommand } from "../dist/opencode/command.js"

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
  }
}

async function runGoalCommand(hooks, sessionID, argumentsText) {
  const output = { parts: [{ type: "text", text: "raw args" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: argumentsText }, output)
  return output
}

async function bindCommandMessage(hooks, sessionID, messageID, output, agent = "build") {
  await hooks["chat.message"](
    { sessionID, messageID, agent },
    { message: { id: messageID }, parts: output.parts },
  )
}

async function markCompleted(store, sessionID, patch = {}) {
  const goal = await store.load(sessionID)
  assert.ok(goal)
  Object.assign(goal, { status: "completed", ...patch })
  await store.save(goal)
  return goal
}

function runWorker(root, sessionID) {
  return new Promise((resolve, reject) => {
    const source = `import { GoalSequenceStore } from "./dist/persistence/sequence-store.js"; const [root, sessionID] = process.argv.slice(1); const result = await new GoalSequenceStore(root).promoteNext(sessionID); console.log(JSON.stringify(result.ok ? { ok: true, id: result.goal.id, recovered: result.recovered } : { ok: false, reason: result.reason, id: null }))`
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, root, sessionID], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `sequence race worker exited ${code}`))
      resolve(JSON.parse(stdout))
    })
  })
}

test("ordered Goal queue persists multiple pending contracts without creating concurrent live Goals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sequence-order-"))
  try {
    const sessionID = "sequence-order-session"
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const goals = new GoalStore(root)
    const sequences = new GoalSequenceStore(root)

    const create = await runGoalCommand(hooks, sessionID, "ship current release")
    await bindCommandMessage(hooks, sessionID, "sequence-create", create)
    const liveBefore = await goals.load(sessionID)
    assert.equal(liveBefore.status, "active")

    const addOne = await runGoalCommand(hooks, sessionID, 'add harden parser --success "parser tests pass" --constraint "public API stays compatible" --max-turns 8')
    await bindCommandMessage(hooks, sessionID, "sequence-add-one", addOne)
    const addTwo = await runGoalCommand(hooks, sessionID, 'add refresh docs --check "npm test"')
    await bindCommandMessage(hooks, sessionID, "sequence-add-two", addTwo)

    const liveAfter = await goals.load(sessionID)
    const queue = await sequences.load(sessionID)
    assert.equal(liveAfter.id, liveBefore.id, "queue mutations must not replace the active Goal")
    assert.deepEqual(queue.items.map((item) => item.objective), ["harden parser", "refresh docs"])
    assert.deepEqual(queue.items[0].acceptance, ["parser tests pass"])
    assert.deepEqual(queue.items[0].constraints, ["public API stays compatible"])
    assert.equal(queue.items[0].budget.maxTurns, 8)
    assert.deepEqual(queue.items[1].checks, ["npm test"])

    const move = await runGoalCommand(hooks, sessionID, `queue move ${queue.items[1].id.slice(0, 10)} 1`)
    await bindCommandMessage(hooks, sessionID, "sequence-move", move)
    assert.deepEqual((await sequences.load(sessionID)).items.map((item) => item.objective), ["refresh docs", "harden parser"])

    const parsed = parseGoalCommand('add final audit --success "all green"')
    assert.equal(parsed.action, "add")
    assert.equal(parseGoalCommand("queue").action, "queue")
    assert.equal(parseGoalCommand(`queue move ${queue.items[0].id.slice(0, 8)} 2`).queuePosition, 2)
    assert.throws(() => parseGoalCommand("next unexpected"), /does not accept arguments/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("completed Goal promotes exactly one queued Goal at session idle with fresh proof state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sequence-promote-"))
  try {
    const sessionID = "sequence-promote-session"
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const goals = new GoalStore(root)
    const sequences = new GoalSequenceStore(root)

    const current = createGoal({ sessionID, objective: "first", execution: { agent: "build" } })
    await goals.save(current)
    const firstQueued = await sequences.enqueue(sessionID, { objective: "second", acceptance: ["second verified"] })
    await sequences.enqueue(sessionID, { objective: "third" })
    await markCompleted(goals, sessionID)

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await new Promise((resolve) => setTimeout(resolve, 25))

    const promoted = await goals.load(sessionID)
    assert.equal(promoted.id, firstQueued.item.id)
    assert.equal(promoted.objective, "second")
    assert.equal(promoted.status, "active")
    assert.equal(promoted.revision, 1)
    assert.deepEqual(promoted.evidence, [])
    assert.deepEqual(promoted.usage, { turns: 0, tokens: 0, cost: 0, runtimeMs: 0, seenMessageIDs: [] })
    assert.equal(promoted.stalledTurns, 0, "activation idle must not count as a no-progress Goal turn")
    assert.equal(promoted.pendingContinuation, undefined, "the one-shot dispatch marker must be consumed")
    assert.deepEqual((await sequences.load(sessionID)).items.map((item) => item.objective), ["third"])

    const archived = await goals.history(sessionID, 10)
    assert.ok(archived.some((record) => record.goalID === current.id && record.reason === "replaced"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unfinished live Goal never advances the ordered Goal sequence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sequence-block-"))
  try {
    const sessionID = "sequence-block-session"
    const goals = new GoalStore(root)
    const sequences = new GoalSequenceStore(root)
    const live = createGoal({ sessionID, objective: "unfinished", execution: { agent: "build" } })
    await goals.save(live)
    const queued = await sequences.enqueue(sessionID, { objective: "must wait" })

    const result = await sequences.promoteNext(sessionID)
    assert.equal(result.ok, false)
    assert.equal(result.reason, "live_unfinished")
    assert.equal((await goals.load(sessionID)).id, live.id)
    assert.equal((await sequences.load(sessionID)).items[0].id, queued.item.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("sequence activation marker recovers a crash after live promotion without duplicating the Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sequence-recover-"))
  try {
    const sessionID = "sequence-crash-session"
    const goals = new GoalStore(root)
    const sequences = new GoalSequenceStore(root)
    const queued = await sequences.enqueue(sessionID, { objective: "recover me" })
    const state = await sequences.load(sessionID)
    state.items[0] = { ...state.items[0], activating: true }
    state.generation += 1
    await mkdir(path.dirname(sequences.fileFor(sessionID)), { recursive: true })
    await writeFile(sequences.fileFor(sessionID), `${JSON.stringify(state, null, 2)}\n`)

    const live = createGoal({ sessionID, objective: queued.item.objective, execution: { agent: "build" } })
    live.id = queued.item.id
    await goals.save(live)

    const recovered = await sequences.promoteNext(sessionID)
    assert.equal(recovered.ok, true)
    assert.equal(recovered.recovered, true)
    assert.equal(recovered.goal.id, queued.item.id)
    assert.equal((await goals.load(sessionID)).id, queued.item.id)
    assert.equal((await sequences.load(sessionID)).items.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent processes cannot consume more than one queued Goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sequence-race-"))
  try {
    const sessionID = "sequence-race-session"
    const goals = new GoalStore(root)
    const sequences = new GoalSequenceStore(root)
    const first = await sequences.enqueue(sessionID, { objective: "one" })
    await sequences.enqueue(sessionID, { objective: "two" })
    const current = createGoal({ sessionID, objective: "done", execution: { agent: "build" } })
    await goals.save(current)
    await markCompleted(goals, sessionID)

    const [left, right] = await Promise.all([runWorker(root, sessionID), runWorker(root, sessionID)])
    const winners = [left, right].filter((item) => item.ok)
    const losers = [left, right].filter((item) => !item.ok)
    assert.equal(winners.length, 1)
    assert.equal(winners[0].id, first.item.id)
    assert.equal(losers.length, 1)
    assert.equal(losers[0].reason, "live_unfinished")
    assert.equal((await goals.load(sessionID)).id, first.item.id)
    assert.deepEqual((await sequences.load(sessionID)).items.map((item) => item.objective), ["two"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Plan or unknown execution context never auto-promotes a queued Goal", async () => {
  for (const execution of [undefined, { agent: "plan" }]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-sequence-boundary-"))
    try {
      const sessionID = `sequence-boundary-${execution?.agent ?? "unknown"}`
      const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
      const goals = new GoalStore(root)
      const sequences = new GoalSequenceStore(root)
      const current = createGoal({ sessionID, objective: "done", ...(execution ? { execution } : {}) })
      await goals.save(current)
      await sequences.enqueue(sessionID, { objective: "must not auto-run" })
      await markCompleted(goals, sessionID)

      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
      assert.equal((await goals.load(sessionID)).id, current.id)
      assert.equal((await sequences.load(sessionID)).items.length, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("fresh sequence continuation marker skips only activation idle accounting", () => {
  const goal = createGoal({ sessionID: "pending-dispatch", objective: "next" })
  goal.pendingContinuation = true
  const first = closeObservedTurn(goal, { now: 10 })
  assert.equal(first.stalledTurns, 0)
  assert.equal(first.pendingContinuation, undefined)
  const second = closeObservedTurn(first, { now: 20 })
  assert.equal(second.stalledTurns, 1)
})
