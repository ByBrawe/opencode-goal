import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(predicate, description, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function readGoal(root) {
  const dir = path.join(root, ".opencode", "goals")
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf8"))
}

function pendingClient() {
  const prompts = []
  const pending = []
  return {
    client: {
      session: {
        list() {
          return Promise.resolve({ data: [{ id: "session-restart" }] })
        },
        status() {
          return Promise.resolve({ data: {} })
        },
        prompt(arg) {
          prompts.push(arg)
          return new Promise((resolve, reject) => pending.push({ resolve, reject }))
        },
        abort() {
          return Promise.resolve(true)
        },
      },
    },
    prompts,
    pending,
  }
}

test("a fresh plugin instance automatically reloads and resumes an active goal exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-goal-restart-"))
  try {
    const first = pendingClient()
    const beforeRestart = await OpenCodeGoalPlugin({ client: first.client, directory: root })
    const commandOutput = { parts: [{ type: "text", text: "raw" }] }

    await beforeRestart["command.execute.before"](
      { command: "goal", sessionID: "session-restart", arguments: "finish restart-safe work --max-turns 8" },
      commandOutput,
    )
    await beforeRestart["chat.message"](
      {
        sessionID: "session-restart",
        messageID: "user-r1",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
      { message: { id: "user-r1" }, parts: commandOutput.parts },
    )
    await beforeRestart.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-r1",
            sessionID: "session-restart",
            parentID: "user-r1",
            role: "assistant",
            time: { created: Date.now() },
            tokens: { input: 0, output: 0, reasoning: 0 },
            cost: 0,
          },
        },
      },
    })
    await beforeRestart.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "patch",
            sessionID: "session-restart",
            messageID: "assistant-r1",
            hash: "restart-progress-1",
            files: ["src/restart.ts"],
          },
        },
      },
    })

    const persisted = await readGoal(root)
    assert.equal(persisted.status, "active")
    assert.equal(persisted.objective, "finish restart-safe work")
    assert.equal(persisted.progressRevision, 1)
    assert.deepEqual(persisted.execution, {
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
    })

    // Simulate a full plugin/process restart: all in-memory ownership, locks and
    // dispatch state disappear, while the project-local goal shard remains.
    // Recovery first waits for an abortable read-only session probe to prove the
    // lazy directory instance can service requests before it sends a prompt.
    const second = pendingClient()
    await OpenCodeGoalPlugin({ client: second.client, directory: root })

    await waitFor(() => second.prompts.length === 1, "automatic startup recovery continuation")

    assert.equal(second.prompts.length, 1, "restart recovery must dispatch one continuation")
    assert.equal(second.prompts[0].path.id, "session-restart")
    assert.equal(second.prompts[0].body.agent, "build")
    assert.deepEqual(second.prompts[0].body.model, { providerID: "provider", modelID: "model" })
    assert.equal(second.prompts[0].body.variant, "high")
    assert.match(second.prompts[0].body.parts[0].text, /finish restart-safe work/)

    const recovered = await readGoal(root)
    assert.equal(recovered.status, "active")
    assert.equal(recovered.progressRevision, 1)
    assert.equal(recovered.observedProgressRevision, 1)
    assert.equal(recovered.stalledTurns, 0, "persisted host progress must survive restart accounting")

    second.pending[0].resolve({})
    await tick()
    assert.equal(second.prompts.length, 1, "startup recovery alone must dispatch exactly once")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
