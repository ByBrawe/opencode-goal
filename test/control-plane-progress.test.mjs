import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin, { isGoalControlPlanePath } from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"

function fakeClient() {
  return {
    session: {
      prompt() { return Promise.resolve({}) },
      abort() { return Promise.resolve(true) },
    },
  }
}

async function bindGoalTurn(hooks, sessionID) {
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID, arguments: "ship the project" }, output)
  await hooks["chat.message"](
    { sessionID, messageID: "user-r1", agent: "build", model: { providerID: "p", modelID: "m" } },
    { message: { id: "user-r1" }, parts: output.parts },
  )
  await hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-r1",
          sessionID,
          parentID: "user-r1",
          role: "assistant",
          time: { created: Date.now() },
          tokens: { input: 0, output: 0, reasoning: 0 },
          cost: 0,
        },
      },
    },
  })
}

async function patch(hooks, sessionID, hash, files) {
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: { type: "patch", sessionID, messageID: "assistant-r1", hash, files },
      },
    },
  })
}

test("Goal control-plane path matcher handles relative, POSIX, and Windows paths narrowly", () => {
  assert.equal(isGoalControlPlanePath(".opencode/goals/state.json"), true)
  assert.equal(isGoalControlPlanePath("/work/repo/.opencode/goal-locks/state.lock"), true)
  assert.equal(isGoalControlPlanePath("C:\\work\\repo\\.opencode\\goal-sequences\\queue.json"), true)
  assert.equal(isGoalControlPlanePath(".opencode/commands/goal.md"), false)
  assert.equal(isGoalControlPlanePath("src/.opencode-helper.ts"), false)
})

test("Goal persistence PatchParts cannot manufacture host progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-self-progress-"))
  const sessionID = "self-progress"
  try {
    const hooks = await OpenCodeGoalPlugin({ client: fakeClient(), directory: root })
    const store = new GoalStore(root)
    await bindGoalTurn(hooks, sessionID)

    const before = await store.load(sessionID)
    assert.ok(before)
    const internal = path.join(root, ".opencode", "goals", "state.json")
    await patch(hooks, sessionID, "internal-only", [internal])

    const afterInternal = await store.load(sessionID)
    assert.equal(afterInternal.progressRevision, before.progressRevision)
    assert.deepEqual(afterInternal.progressFingerprints, before.progressFingerprints)

    const projectFile = path.join(root, "src", "real-work.ts")
    await patch(hooks, sessionID, "mixed", [internal, projectFile])
    const afterMixed = await store.load(sessionID)
    assert.equal(afterMixed.progressRevision, before.progressRevision + 1)
    assert.deepEqual(afterMixed.progressFingerprints, ["patch:mixed"])
    assert.match(afterMixed.progressNotes.at(-1).summary, /src.*real-work\.ts/i)
    assert.doesNotMatch(afterMixed.progressNotes.at(-1).summary, /\.opencode[\\/]goals/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
