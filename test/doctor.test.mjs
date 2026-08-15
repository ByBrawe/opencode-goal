import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { createGoal } from "../dist/domain/goal.js"
import { captureStartupGoals } from "../dist/opencode/recovery.js"
import { GoalSequenceStore } from "../dist/persistence/sequence-store.js"
import { GoalStore } from "../dist/persistence/store.js"

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
  await hooks["command.execute.before"](
    { command: "goal", sessionID, arguments: argumentsText },
    output,
  )
  return output
}

async function bindCommandMessage(hooks, sessionID, messageID, output) {
  await hooks["chat.message"](
    { sessionID, messageID, agent: "build" },
    { message: { id: messageID }, parts: output.parts },
  )
}

test("goal doctor stays available for unsupported live storage and never rewrites it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-doctor-live-"))
  try {
    const sessionID = "doctor-corrupt-live"
    const store = new GoalStore(root)
    const file = store.fileFor(sessionID)
    const future = `${JSON.stringify({
      schemaVersion: 2,
      id: "future-goal",
      sessionID,
      objective: "future schema",
      requirements: [],
      evidence: [],
    }, null, 2)}\n`
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, future, "utf8")

    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const output = await runGoalCommand(hooks, sessionID, "doctor")
    assert.equal(output.noReply, true)
    assert.match(output.parts[0].text, /Goal storage doctor: ISSUES FOUND/)
    assert.match(output.parts[0].text, /Live snapshot: INVALID \(invalid_state\)/)
    assert.match(output.parts[0].text, /Queue storage: missing/)
    assert.match(output.parts[0].text, /unsupported schemaVersion 2/)
    assert.match(output.parts[0].text, /No files were modified/)
    assert.equal(await readFile(file, "utf8"), future)

    await bindCommandMessage(hooks, sessionID, "doctor-command", output)
    assert.equal(await readFile(file, "utf8"), future, "doctor response binding must not enter the core mutating path")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("goal doctor reports corrupt archives without pausing a healthy live goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-doctor-archive-"))
  try {
    const sessionID = "doctor-corrupt-archive"
    const store = new GoalStore(root)
    const live = createGoal({ sessionID, objective: "keep working", now: 100 })
    await store.save(live)

    const archiveFile = store.archiveFileFor(sessionID, "broken-archive")
    const corrupt = "{ broken archive\n"
    await mkdir(path.dirname(archiveFile), { recursive: true })
    await writeFile(archiveFile, corrupt, "utf8")

    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const output = await runGoalCommand(hooks, sessionID, "doctor")
    assert.match(output.parts[0].text, /Live snapshot: valid/)
    assert.match(output.parts[0].text, /Archive storage: INVALID \(invalid_json\)/)
    assert.match(output.parts[0].text, /Queue storage: missing/)
    assert.match(output.parts[0].text, /broken archive|file is not valid JSON/)

    await bindCommandMessage(hooks, sessionID, "doctor-command", output)
    const unchanged = await store.load(sessionID)
    assert.equal(unchanged.id, live.id)
    assert.equal(unchanged.status, "active", "read-only doctor must not pause the live Goal")
    assert.equal(await readFile(archiveFile, "utf8"), corrupt)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("goal doctor reports corrupt queue storage without rewriting it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-doctor-queue-"))
  try {
    const sessionID = "doctor-corrupt-queue"
    const sequences = new GoalSequenceStore(root)
    const queueFile = sequences.fileFor(sessionID)
    const corrupt = "{ broken queue\n"
    await mkdir(path.dirname(queueFile), { recursive: true })
    await writeFile(queueFile, corrupt, "utf8")

    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const output = await runGoalCommand(hooks, sessionID, "doctor")
    assert.equal(output.noReply, true)
    assert.match(output.parts[0].text, /Goal storage doctor: ISSUES FOUND/)
    assert.match(output.parts[0].text, /Queue storage: INVALID \(invalid_json\)/)
    assert.match(output.parts[0].text, /queue: invalid_json/)
    assert.match(output.parts[0].text, /file is not valid JSON/)
    assert.equal(await readFile(queueFile, "utf8"), corrupt)

    await bindCommandMessage(hooks, sessionID, "doctor-command", output)
    assert.equal(await readFile(queueFile, "utf8"), corrupt, "doctor response binding must not rewrite corrupt queue storage")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("goal doctor reports a held session lease without touching it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-doctor-lease-"))
  try {
    const sessionID = "doctor-held-lease"
    const store = new GoalStore(root)
    const live = createGoal({ sessionID, objective: "diagnose the current lease", now: 100 })
    await store.save(live)

    const lockFile = store.lockFileFor(sessionID)
    const acquiredAt = Date.UTC(2026, 7, 15, 5, 0, 0)
    const owner = {
      schemaVersion: 1,
      pid: 424242,
      token: "11111111-1111-1111-1111-111111111111",
      acquiredAt,
      candidateName: ".lock-owner-424242-11111111-1111-1111-1111-111111111111.json",
    }
    const raw = `${JSON.stringify(owner)}\n`
    await mkdir(path.dirname(lockFile), { recursive: true })
    await writeFile(lockFile, raw, "utf8")

    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const output = await runGoalCommand(hooks, sessionID, "doctor")
    assert.equal(output.noReply, true)
    assert.match(output.parts[0].text, /Goal storage doctor: ISSUES FOUND/)
    assert.match(output.parts[0].text, /lease: lock_held/)
    assert.match(output.parts[0].text, /held by pid 424242/)
    assert.match(output.parts[0].text, /2026-08-15T05:00:00\.000Z/)
    assert.match(output.parts[0].text, /separate OpenCode sessions in the same project directory use independent leases/)
    assert.equal(await readFile(lockFile, "utf8"), raw)

    await bindCommandMessage(hooks, sessionID, "doctor-lease-command", output)
    assert.equal(await readFile(lockFile, "utf8"), raw, "doctor response binding must not mutate lease metadata")

    await rm(lockFile, { force: true })
    const clearOutput = await runGoalCommand(hooks, sessionID, "doctor")
    assert.match(clearOutput.parts[0].text, /Goal storage doctor: OK/)
    assert.doesNotMatch(clearOutput.parts[0].text, /lease:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("goal doctor reports corrupt session lease metadata without rewriting it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-doctor-corrupt-lease-"))
  try {
    const sessionID = "doctor-corrupt-lease"
    const store = new GoalStore(root)
    const lockFile = store.lockFileFor(sessionID)
    const corrupt = "{ broken lease\n"
    await mkdir(path.dirname(lockFile), { recursive: true })
    await writeFile(lockFile, corrupt, "utf8")

    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const output = await runGoalCommand(hooks, sessionID, "doctor")
    assert.equal(output.noReply, true)
    assert.match(output.parts[0].text, /Goal storage doctor: ISSUES FOUND/)
    assert.match(output.parts[0].text, /lease: lock_corrupt/)
    assert.match(output.parts[0].text, /lock owner metadata is not valid JSON/)
    assert.match(output.parts[0].text, /No files were modified/)
    assert.equal(await readFile(lockFile, "utf8"), corrupt)

    await bindCommandMessage(hooks, sessionID, "doctor-corrupt-lease-command", output)
    assert.equal(await readFile(lockFile, "utf8"), corrupt, "doctor response binding must not rewrite corrupt lease metadata")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("startup recovery scan isolates corrupt shards and keeps healthy active goals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-doctor-startup-"))
  try {
    const store = new GoalStore(root)
    const healthy = createGoal({ sessionID: "healthy-session", objective: "recover me", now: 100 })
    await store.save(healthy)

    const badSessionID = "bad-session"
    const badFile = store.fileFor(badSessionID)
    await writeFile(badFile, `${JSON.stringify({ schemaVersion: 2, sessionID: badSessionID })}\n`, "utf8")

    const startup = await captureStartupGoals(root)
    assert.deepEqual(startup.map((goal) => goal.id), [healthy.id])
    assert.equal(await readFile(badFile, "utf8"), `${JSON.stringify({ schemaVersion: 2, sessionID: badSessionID })}\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
